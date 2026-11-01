using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using Xunit;

namespace Mira.Stage.Tests
{
    /// <summary>
    /// The REAL daemon (apps/daemon, started with node and tsx, the fake Claude) in a child process, on a free port with a
    /// scratch data directory. Nothing is mocked: the sign-in code is exchanged over HTTP, the stage switch is turned on over
    /// HTTP, the token is read from the daemon's own secrets.json, and the stage connects over a real WebSocket.
    /// </summary>
    internal sealed class LiveDaemon : IDisposable
    {
        private readonly object _gate = new object();
        private readonly StringBuilder _output = new StringBuilder();
        private readonly HttpClientHandler _handler = new HttpClientHandler { UseCookies = true, CookieContainer = new CookieContainer() };
        private readonly bool _ownsDataDir;
        private Process _proc;

        public int Port { get; }
        public string DataDir { get; }
        public HttpClient Http { get; }
        public string Base => "http://127.0.0.1:" + Port;
        public string Output { get { lock (_gate) return _output.ToString(); } }

        /// <summary>
        /// A data directory passed in belongs to the caller (a restart test hands the same one to two daemons in turn) and is
        /// never deleted here; one made here is deleted on Dispose.
        /// </summary>
        public LiveDaemon(int? port = null, string dataDir = null)
        {
            Port = port ?? FreePort();
            _ownsDataDir = dataDir == null;
            DataDir = dataDir ?? Directory.CreateTempSubdirectory("mira-live-").FullName;
            Http = new HttpClient(_handler) { Timeout = TimeSpan.FromSeconds(20) };
        }

        public static string SkipReason()
        {
            if (!Runs("node", "--version")) return "node is not installed";
            if (!Directory.Exists(Path.Combine(TestPaths.RepoRoot, "apps", "daemon", "node_modules", "tsx"))) return "the daemon's dependencies are not installed (run pnpm install)";
            return null;
        }

        public async Task StartAsync()
        {
            var psi = new ProcessStartInfo("node", "--import tsx src/main.ts")
            {
                WorkingDirectory = Path.Combine(TestPaths.RepoRoot, "apps", "daemon"),
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            foreach (var key in new[] { "ANTHROPIC_API_KEY", "DEMO", "OPEN_BROWSER", "MIRA_CONTAINER" }) psi.Environment.Remove(key);
            psi.Environment["DAEMON_PORT"] = Port.ToString();
            psi.Environment["DATA_DIR"] = DataDir;
            psi.Environment["CLAUDE_BACKEND"] = "fake";
            psi.Environment["LOG_LEVEL"] = "warn";
            _proc = Process.Start(psi);
            _proc.OutputDataReceived += (s, e) => { if (e.Data != null) lock (_gate) _output.AppendLine(e.Data); };
            _proc.ErrorDataReceived += (s, e) => { if (e.Data != null) lock (_gate) _output.AppendLine(e.Data); };
            _proc.BeginOutputReadLine();
            _proc.BeginErrorReadLine();
            var link = await WaitFor(() => Regex.Match(Output, @"Sign in\s+(http://127\.0\.0\.1:\d+/\?code=([\w-]+))"), m => m.Success, 40000, "the daemon's sign-in link");
            _code = link.Groups[2].Value;
        }

        private string _code;

        public async Task SignInAsync()
        {
            var r = await SendAsync(HttpMethod.Post, "/api/auth/exchange", new JObject { ["code"] = _code });
            Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        }

        public async Task SetStageAsync(bool on)
        {
            var r = await SendAsync(HttpMethod.Put, "/api/settings/stage", new JObject { ["on"] = on });
            Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        }

        public async Task ChatAsync(string text)
        {
            var r = await SendAsync(HttpMethod.Post, "/api/chat", new JObject { ["text"] = text, ["modality"] = "text" });
            Assert.Equal(HttpStatusCode.Accepted, r.StatusCode);
        }

        public async Task<JObject> SnapshotAsync()
        {
            var r = await SendAsync(HttpMethod.Get, "/api/snapshot", null);
            Assert.Equal(HttpStatusCode.OK, r.StatusCode);
            return JObject.Parse(await r.Content.ReadAsStringAsync());
        }

        private Task<HttpResponseMessage> SendAsync(HttpMethod method, string path, JObject body)
        {
            var req = new HttpRequestMessage(method, Base + path);
            if (method != HttpMethod.Get) req.Headers.TryAddWithoutValidation("Origin", Base);
            if (body != null) req.Content = new StringContent(body.ToString(Newtonsoft.Json.Formatting.None), Encoding.UTF8, "application/json");
            return Http.SendAsync(req);
        }

        public void Kill()
        {
            try { if (_proc != null && !_proc.HasExited) { _proc.Kill(true); _proc.WaitForExit(5000); } } catch (Exception) { /* already gone */ }
        }

        public void Dispose()
        {
            Kill();
            Http.Dispose();
            if (_ownsDataDir)
            {
                try { Directory.Delete(DataDir, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }

        public static async Task<T> WaitFor<T>(Func<T> get, Func<T, bool> done, int ms, string what)
        {
            var t0 = DateTime.UtcNow;
            T v = get();
            while (!done(v))
            {
                if ((DateTime.UtcNow - t0).TotalMilliseconds > ms) throw new Xunit.Sdk.XunitException("timed out waiting for " + what);
                await Task.Delay(25);
                v = get();
            }
            return v;
        }

        private static int FreePort()
        {
            var l = new TcpListener(IPAddress.Loopback, 0);
            l.Start();
            var port = ((IPEndPoint)l.LocalEndpoint).Port;
            l.Stop();
            return port;
        }

        private static bool Runs(string file, string args)
        {
            try
            {
                using (var p = Process.Start(new ProcessStartInfo(file, args) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false }))
                {
                    p.WaitForExit(10000);
                    return p.ExitCode == 0;
                }
            }
            catch (Exception) { return false; }
        }
    }

    [Collection("live daemon")]
    public class LiveDaemonTests
    {
        private static Task Until(Func<bool> condition, string what, int ms = 15000) => LiveDaemon.WaitFor(condition, c => c, ms, what);

        private static StageClient NewClient(LiveDaemon d, HeadlessStageHandler h, string token, Action<StageClientOptions> tweak = null)
        {
            var o = new StageClientOptions
            {
                Url = new Uri("ws://127.0.0.1:" + d.Port + "/ws/stage"),
                Token = token,
                Capabilities = new StageCapabilities { EngineVersion = "6000.0.0f1" },
                Backoff = (a, r) => TimeSpan.FromMilliseconds(100),
            };
            tweak?.Invoke(o);
            return new StageClient(o, h);
        }

        private static string TokenOf(LiveDaemon d)
        {
            var c = StageCredentialsResolver.Resolve(k => k == StageCredentialsResolver.DataDirVariable ? d.DataDir : null);
            Assert.NotNull(c.Token);
            Assert.EndsWith("secrets.json", c.TokenSource);
            return c.Token;
        }

        [SkippableFact]
        public async Task ConnectsToTheRealDaemon_IsGivenTheLook_AndSpeaksWithAudioAndFaceFrames()
        {
            var skip = LiveDaemon.SkipReason();
            Skip.If(skip != null, skip);
            using (var d = new LiveDaemon())
            {
                await d.StartAsync();
                await d.SignInAsync();
                await d.SetStageAsync(true);
                var h = new HeadlessStageHandler("vrm1");
                using (var client = NewClient(d, h, TokenOf(d)))
                {
                    var run = Task.Run(() => client.RunAsync());
                    await Until(() => h.Characters.Count == 2 && h.Scene != null, "the look: her, you, the void", 25000);

                    Assert.Equal("char.assistant", h.AssistantId);
                    Assert.Equal(new[] { "assistant", "user" }, h.Characters.Values.Select(c => c.Role).OrderBy(r => r, StringComparer.Ordinal).ToArray());
                    Assert.Equal(6, h.Scene.Cameras.Count);
                    Assert.Equal("wide", h.ActiveCameraId);
                    Assert.True(h.IsLoaded("env.cerebral-void"), "the void was not loaded");

                    var snap = await d.SnapshotAsync();
                    var stage = (JObject)snap["stage"]["stage"];
                    Assert.True(stage.Value<bool>("connected"));
                    Assert.Equal("unity", stage.Value<string>("engine"));
                    Assert.Equal("vrm1", stage["capabilities"]["rigFamilies"][0].Value<string>());
                    Assert.Equal("6000.0.0f1", stage["capabilities"].Value<string>("engineVersion"));

                    await d.ChatAsync("Hello, what is on my calendar today?");
                    await Until(() => h.Utterances.Any(u => u.Ended && !u.Interrupted), "a finished utterance", 40000);
                    var spoken = h.Utterances.First(u => u.Ended && !u.Interrupted);
                    Assert.True(spoken.AudioFrames > 3, spoken.AudioFrames + " audio frames");
                    Assert.True(spoken.FaceFrames > 3, spoken.FaceFrames + " face frames");
                    Assert.Equal("backend", spoken.FaceSource);
                    Assert.Equal(0, client.RejectedFrames);
                    foreach (var type in new[] { "perform.speak", "perform.affect", "perform.gaze" }) Assert.Contains(type, h.CommandTypes);

                    client.Stop();
                    await run;
                    await LiveDaemon.WaitFor(() => d.SnapshotAsync().GetAwaiter().GetResult()["stage"]["stage"].Value<bool>("connected"), c => !c, 10000, "the daemon to see the stage leave");
                }
                Assert.DoesNotContain("invalid", d.Output, StringComparison.OrdinalIgnoreCase);
                Assert.DoesNotContain("rejected", d.Output, StringComparison.OrdinalIgnoreCase);
            }
        }

        [SkippableFact]
        public async Task AWrongTokenIsRefusedWith401_AndASecondStageWith409WhileTheFirstIsConnected()
        {
            var skip = LiveDaemon.SkipReason();
            Skip.If(skip != null, skip);
            using (var d = new LiveDaemon())
            {
                await d.StartAsync();
                await d.SignInAsync();
                await d.SetStageAsync(true);

                var bad = NewClient(d, new HeadlessStageHandler("vrm1"), new string('x', 43));
                var badRun = Task.Run(() => bad.RunAsync());
                await Until(() => bad.LastRefusalStatus == 401, "a 401 for the wrong token", 15000);
                Assert.NotEqual(StageConnectionState.Connected, bad.State);
                bad.Stop();
                await badRun;

                var token = TokenOf(d);
                var firstHandler = new HeadlessStageHandler("vrm1");
                var first = NewClient(d, firstHandler, token);
                var firstRun = Task.Run(() => first.RunAsync());
                await Until(() => first.State == StageConnectionState.Connected && firstHandler.Scene != null, "the first stage", 25000);

                var second = NewClient(d, new HeadlessStageHandler("vrm1"), token);
                var secondRun = Task.Run(() => second.RunAsync());
                await Until(() => second.LastRefusalStatus == 409, "a 409 for the second stage", 15000);
                Assert.Equal(StageConnectionState.Connected, first.State);
                second.Stop();
                await secondRun;
                first.Stop();
                await firstRun;
            }
        }

        [SkippableFact]
        public async Task AStageThatIsOffIsRefusedWith403_AndConnectsOnceTheSwitchIsTurnedOn()
        {
            var skip = LiveDaemon.SkipReason();
            Skip.If(skip != null, skip);
            using (var d = new LiveDaemon())
            {
                await d.StartAsync();
                await d.SignInAsync();
                await d.SetStageAsync(false); // the switch is ON until the user turns it off, so turn it off first
                var h = new HeadlessStageHandler("vrm1");
                var client = NewClient(d, h, TokenOf(d));
                var run = Task.Run(() => client.RunAsync());
                await Until(() => client.LastRefusalStatus == 403 && client.State == StageConnectionState.Refused, "a 403 while the stage switch is off", 15000);
                Assert.Equal(0, h.Connects);
                await d.SetStageAsync(true);
                await Until(() => client.State == StageConnectionState.Connected && h.Scene != null, "the stage to connect once the switch is on", 25000);
                client.Stop();
                await run;
            }
        }

        [SkippableFact]
        public async Task WhenTheDaemonRestartsTheStageReconnectsByItselfAndIsGivenTheLookAgain()
        {
            var skip = LiveDaemon.SkipReason();
            Skip.If(skip != null, skip);
            var dataDir = Directory.CreateTempSubdirectory("mira-live-restart-").FullName;
            LiveDaemon second = null;
            try
            {
                string token;
                var h = new HeadlessStageHandler("vrm1");
                StageClient client;
                Task run;
                int port;
                using (var first = new LiveDaemon(dataDir: dataDir))
                {
                    port = first.Port;
                    await first.StartAsync();
                    await first.SignInAsync();
                    await first.SetStageAsync(true);
                    token = TokenOf(first);
                    client = NewClient(first, h, token);
                    run = Task.Run(() => client.RunAsync());
                    await Until(() => h.Connects == 1 && h.Scene != null, "the first connection", 25000);
                    first.Kill();
                    await Until(() => h.Disconnects >= 1, "the stage to notice the daemon is gone", 15000);
                }
                var commandsBefore = h.CommandTypes.Count;
                second = new LiveDaemon(port, dataDir);
                await second.StartAsync();
                Assert.Equal(token, TokenOf(second)); // the token survives a restart: it is in the data directory
                await second.SignInAsync();
                await second.SetStageAsync(true);
                await Until(() => h.Connects == 2 && h.CommandTypes.Count >= commandsBefore + 3, "the stage to reconnect and be given the look again", 30000);
                Assert.True(h.CommandTypes.Skip(commandsBefore).Count(t => t == "character.load") >= 2, "she and the user's character were not loaded again");
                client.Stop();
                await run;
            }
            finally
            {
                second?.Dispose();
                try { Directory.Delete(dataDir, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }
    }
}
