using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using Xunit;

namespace Mira.Stage.Tests
{
    /// <summary>A wire without a network: the test pushes what the daemon would send and reads what the client sent.</summary>
    internal sealed class FakeTransport : IStageTransport
    {
        private readonly ConcurrentQueue<StageMessage> _incoming = new ConcurrentQueue<StageMessage>();
        private readonly SemaphoreSlim _signal = new SemaphoreSlim(0);
        private readonly ConcurrentQueue<string> _sent = new ConcurrentQueue<string>();

        public Exception ConnectError { get; set; }
        public string Token { get; private set; }
        public Uri Url { get; private set; }
        public bool Disposed { get; private set; }

        public IReadOnlyList<JObject> Sent => _sent.Select(JObject.Parse).ToList();
        public IReadOnlyList<string> SentTypes => Sent.Select(j => j.Value<string>("type")).ToList();

        public Task ConnectAsync(Uri url, string bearerToken, CancellationToken ct)
        {
            if (ConnectError != null) throw ConnectError;
            Url = url;
            Token = bearerToken;
            return Task.CompletedTask;
        }

        public Task SendTextAsync(string text, CancellationToken ct)
        {
            _sent.Enqueue(text);
            return Task.CompletedTask;
        }

        public async Task<StageMessage> ReceiveAsync(CancellationToken ct)
        {
            await _signal.WaitAsync(ct);
            _incoming.TryDequeue(out var m);
            return m;
        }

        public Task CloseAsync(string reason) => Task.CompletedTask;
        public void Dispose() { Disposed = true; }

        public void PushText(string json) { _incoming.Enqueue(new StageMessage { IsText = true, Text = json }); _signal.Release(); }
        public void PushGolden(string name) => PushText(TestPaths.ReadGolden("commands/" + name + ".json"));
        public void PushBinary(byte[] data) { _incoming.Enqueue(new StageMessage { Binary = data }); _signal.Release(); }
        public void PushClose(string reason = "daemon stopped") { _incoming.Enqueue(new StageMessage { Closed = true, CloseReason = reason }); _signal.Release(); }
    }

    public class ClientTests
    {
        private const string Token = "t0ken-t0ken-t0ken-t0ken-t0ken-t0ken-t0ken-t0ken";
        private static readonly TimeSpan Quick = TimeSpan.FromMilliseconds(15);

        private sealed class Running : IDisposable
        {
            public StageClient Client;
            public Task Run;
            public void Dispose() { Client.Stop(); try { Run.Wait(3000); } catch (AggregateException) { } Client.Dispose(); }
        }

        private static Running Start(IStageHandler handler, Func<IStageTransport> factory, Action<StageClientOptions> tweak = null)
        {
            var o = new StageClientOptions { Token = Token, TransportFactory = factory, Backoff = (a, r) => Quick, Clock = () => 5000 };
            tweak?.Invoke(o);
            var client = new StageClient(o, handler);
            return new Running { Client = client, Run = Task.Run(() => client.RunAsync()) };
        }

        private static async Task Until(Func<bool> condition, string what, int ms = 5000)
        {
            var t0 = DateTime.UtcNow;
            while ((DateTime.UtcNow - t0).TotalMilliseconds < ms)
            {
                if (condition()) return;
                await Task.Delay(10);
            }
            throw new Xunit.Sdk.XunitException("timed out waiting for " + what);
        }

        private static byte[] Audio(string utteranceId, double tStartMs, int ms)
        {
            var samples = ms * StageProtocol.AudioSampleRate / 1000;
            return StageFrames.Encode(FrameKind.Audio, StageFrames.Fnv1a32(utteranceId), tStartMs, new byte[samples * 2]);
        }

        [Fact]
        public async Task SaysHelloFirst_WithTheTokenInTheHeaderOnly_AndTheCapabilitiesItDeclares()
        {
            var t = new FakeTransport();
            var h = new HeadlessStageHandler();
            using (var r = Start(h, () => t, o => o.Capabilities = new StageCapabilities { EngineVersion = "6000.0.5f1" }))
            {
                await Until(() => t.SentTypes.Contains("hello"), "hello");
                Assert.Equal("hello", t.SentTypes[0]);
                var hello = t.Sent[0];
                Assert.Equal("mira-stage/1", hello.Value<string>("protocol"));
                Assert.Equal("unity", hello["capabilities"].Value<string>("engine"));
                Assert.Equal("6000.0.5f1", hello["capabilities"].Value<string>("engineVersion"));
                Assert.Equal(5000, hello.Value<double>("stageClockMs"));
                Assert.Equal(Token, t.Token);
                Assert.Equal(string.Empty, t.Url.Query);
                Assert.DoesNotContain(Token, string.Join("\n", t.Sent.Select(j => j.ToString())));
                Assert.Equal(StageConnectionState.Connected, r.Client.State);
                Assert.Equal(1, h.Connects);
            }
        }

        [Fact]
        public async Task AnswersEveryCommandInOrder_LoadsAssetsFirst_AndTheHandlerHoldsTheLook()
        {
            var t = new FakeTransport();
            var h = new HeadlessStageHandler();
            using (Start(h, () => t))
            {
                t.PushGolden("character.load");
                t.PushGolden("scene.load");
                t.PushGolden("scene.camera");
                t.PushGolden("perform.affect");
                t.PushGolden("perform.gaze");
                t.PushGolden("perform.idle");
                await Until(() => t.SentTypes.Count(x => x == "command.done") == 6, "six acknowledgements");
                var done = t.Sent.Where(j => j.Value<string>("type") == "command.done").Select(j => j.Value<string>("id")).ToArray();
                Assert.Equal(new[] { "cmd-001", "cmd-005", "cmd-010", "cmd-014", "cmd-016", "cmd-018" }, done);
                // the assets of a command are reported loaded BEFORE that command is done
                var types = t.SentTypes.ToList();
                Assert.True(types.IndexOf("asset.loaded") < types.IndexOf("command.done"));
                Assert.Equal(3, types.Count(x => x == "asset.loaded"));
                Assert.Equal("char.assistant", h.AssistantId);
                Assert.Equal("closeup", h.ActiveCameraId);
                Assert.Equal("neutral", h.Affect.Label);
                Assert.Equal("point", h.Gaze.Kind);
                Assert.Equal("attentive", h.IdleProfile);
                Assert.True(h.IsLoaded("asset.env.void"));
            }
        }

        [Fact]
        public async Task WhatItCannotDoIsFailedWithAPlainReason_NotIgnored()
        {
            var t = new FakeTransport();
            var h = new HeadlessStageHandler();
            using (Start(h, () => t))
            {
                t.PushGolden("scene.construct");
                t.PushText("{\"id\":\"future-1\",\"type\":\"perform.dance\"}");
                t.PushGolden("scene.camera"); // no scene yet
                t.PushText(TestPaths.ReadGolden("commands/character.load.json").Replace("\"rigFamily\": \"vrm1\"", "\"rigFamily\": \"metahuman\""));
                await Until(() => t.SentTypes.Count(x => x == "command.failed") == 4, "four failures");
                var failed = t.Sent.Where(j => j.Value<string>("type") == "command.failed").ToDictionary(j => j.Value<string>("id"), j => j.Value<string>("reason"));
                Assert.Contains("scene.construct", failed["cmd-007"]);
                Assert.Contains("perform.dance", failed["future-1"]);
                Assert.Equal("no scene is loaded", failed["cmd-010"]);
                Assert.Equal("rig family metahuman is not supported", failed["cmd-001"]);
            }
        }

        [Fact]
        public async Task BadFramesAreAnsweredAndTheStageKeepsServing()
        {
            var t = new FakeTransport();
            using (Start(new HeadlessStageHandler(), () => t))
            {
                t.PushText("this is not json");
                t.PushText("{\"id\":\"c9\",\"type\":\"perform.speak\",\"utteranceId\":\"u\"}");
                t.PushBinary(new byte[] { 1, 2, 3 });
                t.PushGolden("scene.lighting"); // no scene: failed, but proves the loop is alive
                await Until(() => t.SentTypes.Count(x => x == "command.failed") == 2 && t.SentTypes.Contains("error"), "the answers");
                var err = t.Sent.First(j => j.Value<string>("type") == "error");
                Assert.Equal("invalid JSON", err.Value<string>("message"));
                Assert.False(err.Value<bool>("fatal"));
                Assert.Contains("audio is missing", t.Sent.First(j => j.Value<string>("id") == "c9").Value<string>("reason"));
            }
        }

        [Fact]
        public async Task AHandlerThatThrowsFailsThatCommandOnly()
        {
            var t = new FakeTransport();
            var h = new ScriptedHandler { OnHandle = c => c.Type == "scene.camera" ? throw new InvalidOperationException("renderer exploded") : Task.FromResult(CommandResult.Done) };
            using (Start(h, () => t))
            {
                t.PushGolden("scene.camera");
                t.PushGolden("perform.idle");
                await Until(() => t.SentTypes.Contains("command.failed") && t.SentTypes.Contains("command.done"), "both answers");
                Assert.Equal("internal error: renderer exploded", t.Sent.First(j => j.Value<string>("type") == "command.failed").Value<string>("reason"));
                Assert.Equal("cmd-018", t.Sent.First(j => j.Value<string>("type") == "command.done").Value<string>("id"));
            }
        }

        [Fact]
        public async Task CommandsRunOneAtATimeInOrder_ButFramesAreNotHeldBehindThem()
        {
            var t = new FakeTransport();
            var gate = new TaskCompletionSource<bool>();
            var log = new ConcurrentQueue<string>();
            var h = new ScriptedHandler
            {
                OnHandle = async c =>
                {
                    log.Enqueue("start " + c.Id);
                    if (c.Id == "cmd-001") await gate.Task;
                    log.Enqueue("end " + c.Id);
                    return CommandResult.Done;
                },
                OnAudio = f => log.Enqueue("audio"),
            };
            using (Start(h, () => t))
            {
                t.PushGolden("character.load"); // cmd-001 waits on the gate
                t.PushGolden("scene.camera");   // cmd-010 must not start before cmd-001 ends
                await Until(() => log.Contains("start cmd-001"), "the first command to start");
                t.PushBinary(Audio("utt-x", 0, 20));
                await Until(() => log.Contains("audio"), "the audio frame, while the first command is still running");
                Assert.DoesNotContain("start cmd-010", log);
                gate.SetResult(true);
                await Until(() => t.SentTypes.Count(x => x == "command.done") == 2, "both done");
                Assert.Equal(new[] { "start cmd-001", "audio", "end cmd-001", "start cmd-010", "end cmd-010" }, log.ToArray());
            }
        }

        [Fact]
        public async Task SpeechPlaysVirtually_StartedOnTheFirstAudio_EndedWhenAllHasArrived_FaceFramesCounted()
        {
            var t = new FakeTransport();
            var h = new HeadlessStageHandler();
            using (Start(h, () => t, o => { var n = 0.0; o.Clock = () => n += 100; }))
            {
                t.PushGolden("perform.speak"); // utt-0001, 1200 ms of audio
                await Until(() => t.SentTypes.Contains("command.done"), "the speak command to be accepted");
                Assert.DoesNotContain("speak.started", t.SentTypes);
                for (var i = 0; i < 60; i++)
                {
                    t.PushBinary(Audio("utt-0001", 5000 + i * 20, 20));
                    if (i == 0) await Until(() => t.SentTypes.Contains("speak.started"), "speak.started");
                }
                var face = Enumerable.Repeat(0.25f, 52 * 3).SelectMany(BitConverter.GetBytes).ToArray();
                t.PushBinary(StageFrames.Encode(FrameKind.Face, StageFrames.Fnv1a32("utt-0001"), 5000, face));
                await Until(() => t.SentTypes.Contains("speak.ended"), "speak.ended");
                var ended = t.Sent.First(j => j.Value<string>("type") == "speak.ended");
                Assert.Equal("utt-0001", ended.Value<string>("utteranceId"));
                Assert.False(ended.Value<bool>("interrupted"));
                var u = h.Utterances.Single();
                Assert.Equal(60, u.AudioFrames);
                Assert.Equal(1200, u.ReceivedMs, 3);
                Assert.True(u.Ended);
                Assert.Equal(1, t.Sent.Count(j => j.Value<string>("type") == "speak.started"));
            }
        }

        [Fact]
        public async Task ACancelEndsTheUtteranceInterrupted_AndLateFramesAreIgnored()
        {
            var t = new FakeTransport();
            var h = new HeadlessStageHandler();
            using (Start(h, () => t))
            {
                t.PushGolden("perform.speak");
                // the daemon waits for the speak command's acknowledgement before it sends that utterance's frames; so does this test
                await Until(() => t.SentTypes.Contains("command.done"), "the speak command to be accepted");
                t.PushBinary(Audio("utt-0001", 5000, 20));
                await Until(() => t.SentTypes.Contains("speak.started"), "speak.started");
                t.PushGolden("perform.cancel");
                await Until(() => t.SentTypes.Contains("speak.ended"), "speak.ended");
                Assert.True(t.Sent.First(j => j.Value<string>("type") == "speak.ended").Value<bool>("interrupted"));
                t.PushBinary(Audio("utt-0001", 5020, 20));
                await Task.Delay(100);
                Assert.Equal(1, h.Utterances.Single().AudioFrames);
                Assert.Equal(1, t.SentTypes.Count(x => x == "speak.ended"));
            }
        }

        [Fact]
        public async Task AFrameTheDecoderRefusesIsCountedNotPlayed()
        {
            var t = new FakeTransport();
            var h = new HeadlessStageHandler();
            using (var r = Start(h, () => t))
            {
                await Until(() => t.SentTypes.Contains("hello"), "hello");
                t.PushBinary(new byte[] { 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1 });
                t.PushBinary(new byte[5]);
                await Until(() => r.Client.RejectedFrames == 2, "two rejected frames");
            }
        }

        [Fact]
        public async Task WhenTheDaemonGoesAwayItReconnects_SaysHelloAgain_AndIsGivenTheLookAgain()
        {
            var first = new FakeTransport();
            var second = new FakeTransport();
            var queue = new ConcurrentQueue<FakeTransport>(new[] { first, second });
            var h = new HeadlessStageHandler();
            using (var r = Start(h, () => queue.TryDequeue(out var next) ? next : new FakeTransport { ConnectError = new IOException("daemon is down") }))
            {
                first.PushGolden("scene.load");
                await Until(() => first.SentTypes.Contains("command.done"), "the first connection to work");
                first.PushClose("daemon restarting");
                await Until(() => second.SentTypes.Contains("hello"), "hello on the second connection");
                second.PushGolden("scene.load");
                await Until(() => second.SentTypes.Contains("command.done"), "the second connection to work");
                Assert.Equal(2, h.Connects);
                Assert.True(h.Disconnects >= 1);
                Assert.True(first.Disposed);
                Assert.Equal(StageConnectionState.Connected, r.Client.State);
            }
        }

        [Theory]
        [InlineData(401)]
        [InlineData(403)]
        [InlineData(409)]
        public async Task ARefusalIsRememberedAndRetried_NotCrashedOn(int status)
        {
            var attempts = 0;
            var transport = new FakeTransport { ConnectError = new StageRefusedException(status, "refused") };
            using (var r = Start(new HeadlessStageHandler(), () => { attempts++; return transport; }))
            {
                await Until(() => attempts >= 3, "three attempts");
                Assert.Equal(status, r.Client.LastRefusalStatus);
                Assert.Contains(r.Client.State, new[] { StageConnectionState.Refused, StageConnectionState.Connecting });
            }
        }

        [Fact]
        public void TheBackoffGrowsAndWaitsLongerForARefusal()
        {
            Assert.Equal(150, StageClientOptions.DefaultBackoff(1, 0).TotalMilliseconds);
            Assert.Equal(300, StageClientOptions.DefaultBackoff(2, 0).TotalMilliseconds);
            Assert.Equal(2000, StageClientOptions.DefaultBackoff(10, 0).TotalMilliseconds);
            Assert.Equal(5000, StageClientOptions.DefaultBackoff(1, 401).TotalMilliseconds);
            Assert.Equal(3000, StageClientOptions.DefaultBackoff(1, 409).TotalMilliseconds);
        }

        [Fact]
        public async Task StopEndsTheRunLoop_AndDoesNotReconnect()
        {
            var t = new FakeTransport();
            var h = new HeadlessStageHandler();
            var r = Start(h, () => t);
            await Until(() => t.SentTypes.Contains("hello"), "hello");
            r.Client.Stop();
            var finished = await Task.WhenAny(r.Run, Task.Delay(3000));
            Assert.Same(r.Run, finished);
            Assert.Equal(StageConnectionState.Stopped, r.Client.State);
            Assert.True(t.Disposed);
            r.Client.Dispose();
        }

        [Fact]
        public async Task PerfIsReportedOnItsInterval_WhenAProbeIsGiven()
        {
            var t = new FakeTransport();
            using (Start(new HeadlessStageHandler(), () => t, o => { o.PerfInterval = TimeSpan.FromMilliseconds(30); o.PerfProvider = () => new PerfSample { Fps = 90, GpuMs = 4.5, VramMb = 1800 }; }))
            {
                await Until(() => t.SentTypes.Count(x => x == "perf") >= 2, "two perf events");
                var p = t.Sent.First(j => j.Value<string>("type") == "perf");
                Assert.Equal(90, p.Value<double>("fps"));
                Assert.Equal(4.5, p.Value<double>("gpuMs"));
                Assert.Equal(1800, p.Value<double>("vramMb"));
            }
        }

        [Fact]
        public async Task EventsFromTheEngineLeaveInTheOrderTheyWereRaised()
        {
            var t = new FakeTransport();
            var h = new HeadlessStageHandler();
            using (var r = Start(h, () => t))
            {
                await Until(() => t.SentTypes.Contains("hello"), "hello");
                r.Client.UserPresence(true, true, "near");
                r.Client.ObjectClicked("obj.chair");
                r.Client.CharacterInteract("char.assistant", "hand", "click");
                r.Client.ReportError("renderer warning");
                await Until(() => t.SentTypes.Count >= 5, "the events");
                Assert.Equal(new[] { "hello", "user.presence", "object.clicked", "character.interact", "error" }, t.SentTypes.Take(5).ToArray());
            }
        }

        private sealed class ScriptedHandler : IStageHandler
        {
            public Func<StageCommand, Task<CommandResult>> OnHandle { get; set; } = c => Task.FromResult(CommandResult.Done);
            public Action<AudioFrame> OnAudio { get; set; } = f => { };
            public void OnConnected(IStageSink sink) { }
            public void OnDisconnected(string reason) { }
            public Task<CommandResult> HandleAsync(StageCommand command, CancellationToken ct) => OnHandle(command);
            public void OnAudioFrame(AudioFrame frame) => OnAudio(frame);
            public void OnFaceFrames(FaceFrames frames) { }
        }
    }
}
