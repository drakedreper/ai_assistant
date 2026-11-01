// The stage client: connects to the daemon's /ws/stage, says hello, runs every command through the handler one at a time
// and in order, acknowledges it, plays frames as they arrive, and reconnects when the daemon goes away (a restart).
// It mirrors the simulator stage (packages/stage-core/src/sim) and apps/daemon/src/stage/simClient.ts.
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;

namespace Mira.Stage
{
    public enum StageConnectionState
    {
        Idle,
        Connecting,
        Connected,
        /// <summary>The daemon refused the upgrade; see LastRefusalStatus (401 token, 403 stage off or Host, 409 another stage).</summary>
        Refused,
        Disconnected,
        Stopped,
    }

    public sealed class PerfSample
    {
        public double Fps { get; set; }
        public double GpuMs { get; set; }
        public double VramMb { get; set; }
    }

    public sealed class StageClientOptions
    {
        public Uri Url { get; set; } = new Uri("ws://127.0.0.1:" + StageProtocol.DefaultPort + StageProtocol.WebSocketPath);
        /// <summary>The stage token (a secret: never log it).</summary>
        public string Token { get; set; }
        public StageCapabilities Capabilities { get; set; } = new StageCapabilities();
        public bool Reconnect { get; set; } = true;
        public Func<IStageTransport> TransportFactory { get; set; } = () => new WebSocketStageTransport();
        /// <summary>The stage clock in milliseconds; default is the time since the client was created.</summary>
        public Func<double> Clock { get; set; }
        /// <summary>Delay before attempt n (1-based); the second argument is the last refusal status, or 0.</summary>
        public Func<int, int, TimeSpan> Backoff { get; set; } = DefaultBackoff;
        /// <summary>When set, a perf event is sent every PerfInterval with what it returns (null skips one).</summary>
        public Func<PerfSample> PerfProvider { get; set; }
        public TimeSpan PerfInterval { get; set; } = TimeSpan.FromSeconds(2);

        public static TimeSpan DefaultBackoff(int attempt, int refusal)
        {
            var ms = Math.Min(2000.0, 150.0 * Math.Pow(2, Math.Max(0, attempt - 1)));
            if (refusal == 401) ms = Math.Max(ms, 5000);
            else if (refusal == 403 || refusal == 409) ms = Math.Max(ms, 3000);
            return TimeSpan.FromMilliseconds(ms);
        }
    }

    public sealed class StageClient : IStageSink, IDisposable
    {
        private readonly StageClientOptions _o;
        private readonly IStageHandler _handler;
        private readonly Stopwatch _clock = Stopwatch.StartNew();
        private readonly CancellationTokenSource _stop = new CancellationTokenSource();
        private volatile Outbox _outbox;
        private int _rejectedFrames;
        private int _lastRefusal;

        public StageClient(StageClientOptions options, IStageHandler handler)
        {
            _o = options ?? throw new ArgumentNullException(nameof(options));
            _handler = handler ?? throw new ArgumentNullException(nameof(handler));
            if (string.IsNullOrEmpty(_o.Token)) throw new ArgumentException("the stage token is missing");
            if (_o.Url.Scheme != "ws") throw new ArgumentException("the stage URL must be ws:// (the daemon is loopback only)");
            if (!string.IsNullOrEmpty(_o.Url.Query)) throw new ArgumentException("the stage URL must not carry a query string");
        }

        public StageConnectionState State { get; private set; } = StageConnectionState.Idle;
        /// <summary>HTTP status of the last refused attempt, or 0.</summary>
        public int LastRefusalStatus => _lastRefusal;
        /// <summary>Binary frames the decoder refused (truncated, misaligned, out-of-range weights...).</summary>
        public int RejectedFrames => _rejectedFrames;
        public event Action<StageConnectionState, string> StateChanged;

        public double StageNowMs => _o.Clock != null ? _o.Clock() : _clock.Elapsed.TotalMilliseconds;

        /// <summary>Connect, serve and reconnect until cancelled or stopped. Never throws for network problems.</summary>
        public async Task RunAsync(CancellationToken external = default)
        {
            using (var linked = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token, external))
            {
                var ct = linked.Token;
                var attempt = 0;
                while (!ct.IsCancellationRequested)
                {
                    attempt++;
                    SetState(StageConnectionState.Connecting, null);
                    var transport = _o.TransportFactory();
                    try
                    {
                        await transport.ConnectAsync(_o.Url, _o.Token, ct).ConfigureAwait(false);
                        attempt = 0;
                        _lastRefusal = 0;
                        await ServeAsync(transport, ct).ConfigureAwait(false);
                    }
                    catch (StageRefusedException e)
                    {
                        _lastRefusal = e.Status;
                        SetState(StageConnectionState.Refused, e.Message);
                    }
                    catch (OperationCanceledException) when (ct.IsCancellationRequested)
                    {
                        break;
                    }
                    catch (Exception e)
                    {
                        SetState(StageConnectionState.Disconnected, e.Message);
                    }
                    finally
                    {
                        try { await transport.CloseAsync("client leaving").ConfigureAwait(false); } catch (Exception) { /* best effort */ }
                        transport.Dispose();
                    }

                    if (!_o.Reconnect || ct.IsCancellationRequested) break;
                    try { await Task.Delay(_o.Backoff(attempt, _lastRefusal), ct).ConfigureAwait(false); }
                    catch (OperationCanceledException) { break; }
                }
                SetState(StageConnectionState.Stopped, null);
            }
        }

        public void Stop() => _stop.Cancel();

        public void Dispose()
        {
            _stop.Cancel();
            _stop.Dispose();
        }

        // ------------------------------------------------------------------------------------------ one connection

        private async Task ServeAsync(IStageTransport transport, CancellationToken ct)
        {
            using (var conn = CancellationTokenSource.CreateLinkedTokenSource(ct))
            {
                var outbox = new Outbox(transport, conn.Token);
                _outbox = outbox;
                var commands = new CommandQueue();
                string reason = "closed";
                Task worker = null, perf = null, sender = null;
                try
                {
                    sender = Task.Run(() => outbox.RunAsync());
                    // hello is the first thing the daemon hears; it must arrive within its hello timeout
                    Send(new HelloEvent { Capabilities = _o.Capabilities, StageClockMs = StageNowMs });
                    SetState(StageConnectionState.Connected, null);
                    SafeHandler(() => _handler.OnConnected(this));
                    worker = Task.Run(() => RunCommandsAsync(commands, conn.Token));
                    if (_o.PerfProvider != null) perf = Task.Run(() => RunPerfAsync(conn.Token));

                    while (true)
                    {
                        var msg = await transport.ReceiveAsync(conn.Token).ConfigureAwait(false);
                        if (msg.Closed)
                        {
                            reason = msg.CloseReason ?? "closed";
                            break;
                        }
                        if (msg.IsText) OnText(msg.Text, commands);
                        else OnBinary(msg.Binary);
                    }
                }
                finally
                {
                    conn.Cancel();
                    _outbox = null;
                    commands.Complete();
                    foreach (var t in new[] { worker, perf, sender })
                    {
                        if (t == null) continue;
                        try { await t.ConfigureAwait(false); } catch (OperationCanceledException) { /* leaving */ }
                    }
                    SafeHandler(() => _handler.OnDisconnected(reason));
                    SetState(StageConnectionState.Disconnected, reason);
                }
            }
        }

        private void OnText(string text, CommandQueue commands)
        {
            var parsed = StageCommandParser.Parse(text);
            if (parsed.Ok)
            {
                commands.Enqueue(parsed.Command);
                return;
            }
            // Like the simulator: a frame with an id is answered for that id, one without is reported as an error.
            if (!string.IsNullOrEmpty(parsed.Id)) Send(new CommandFailedEvent { Id = parsed.Id, Reason = Cut(parsed.Error, 160) });
            else Send(new ErrorEvent { Message = Cut(parsed.Error, 160), Fatal = false });
        }

        private void OnBinary(byte[] data)
        {
            var decoded = StageFrames.Decode(data);
            if (!decoded.Ok)
            {
                Interlocked.Increment(ref _rejectedFrames);
                return;
            }
            var f = decoded.Frame;
            switch (f.Kind)
            {
                case FrameKind.Audio:
                    SafeHandler(() => _handler.OnAudioFrame(StageFrames.ToAudio(f)));
                    break;
                case FrameKind.Face:
                    SafeHandler(() => _handler.OnFaceFrames(StageFrames.ToFace(f)));
                    break;
            }
        }

        private async Task RunCommandsAsync(CommandQueue commands, CancellationToken ct)
        {
            while (true)
            {
                StageCommand cmd;
                try { cmd = await commands.DequeueAsync(ct).ConfigureAwait(false); }
                catch (OperationCanceledException) { return; }
                if (cmd == null) return;
                CommandResult result;
                try
                {
                    result = await _handler.HandleAsync(cmd, ct).ConfigureAwait(false) ?? CommandResult.Fail("the stage returned nothing");
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception e)
                {
                    result = CommandResult.Fail("internal error: " + e.Message);
                }
                if (result.Ok) Send(new CommandDoneEvent { Id = cmd.Id });
                else Send(new CommandFailedEvent { Id = cmd.Id, Reason = Cut(result.Reason ?? "failed", 160) });
            }
        }

        private async Task RunPerfAsync(CancellationToken ct)
        {
            while (!ct.IsCancellationRequested)
            {
                try { await Task.Delay(_o.PerfInterval, ct).ConfigureAwait(false); }
                catch (OperationCanceledException) { return; }
                PerfSample p = null;
                try { p = _o.PerfProvider(); } catch (Exception) { /* a broken probe must not end the stage */ }
                if (p != null) Perf(p.Fps, p.GpuMs, p.VramMb);
            }
        }

        // ------------------------------------------------------------------------------------------ the sink

        public void AssetLoaded(string assetId, double ms) => Send(new AssetLoadedEvent { AssetId = assetId, Ms = ms });
        public void AssetFailed(string assetId, string reason) => Send(new AssetFailedEvent { AssetId = assetId, Reason = Cut(reason, 200) });
        public void SpeakStarted(string utteranceId) => Send(new SpeakStartedEvent { UtteranceId = utteranceId, StageMs = StageNowMs });
        public void SpeakEnded(string utteranceId, bool interrupted) => Send(new SpeakEndedEvent { UtteranceId = utteranceId, StageMs = StageNowMs, Interrupted = interrupted });
        public void Perf(double fps, double gpuMs, double vramMb) => Send(new PerfEvent { Fps = fps, GpuMs = gpuMs, VramMb = vramMb });
        public void UserPresence(bool present, bool? lookingAtScreen = null, string distance = null) => Send(new UserPresenceEvent { Present = present, LookingAtScreen = lookingAtScreen, Distance = distance });
        public void ObjectClicked(string objectId, string button = "primary") => Send(new ObjectClickedEvent { ObjectId = objectId, Button = button });
        public void CharacterInteract(string characterId, string region, string kind) => Send(new CharacterInteractEvent { CharacterId = characterId, Region = region, Kind = kind });
        public void ReportError(string message, bool fatal = false) => Send(new ErrorEvent { Message = Cut(message, 400), Fatal = fatal });

        /// <summary>Queue an event for the daemon, in call order. Dropped when there is no connection (events only mean something on a live one).</summary>
        public void Send(StageEvent e) => _outbox?.Enqueue(StageJson.Serialize(e));

        // ------------------------------------------------------------------------------------------ helpers

        private void SetState(StageConnectionState state, string detail)
        {
            State = state;
            var handler = StateChanged;
            if (handler == null) return;
            try { handler(state, detail); } catch (Exception) { /* a listener must not break the client */ }
        }

        private void SafeHandler(Action action)
        {
            try { action(); }
            catch (Exception e) { Send(new ErrorEvent { Message = Cut("handler: " + e.Message, 400), Fatal = false }); }
        }

        private static string Cut(string s, int max) => string.IsNullOrEmpty(s) ? string.Empty : (s.Length <= max ? s : s.Substring(0, max));

        /// <summary>Events leave in the order they were queued, one send at a time.</summary>
        private sealed class Outbox
        {
            private readonly IStageTransport _transport;
            private readonly CancellationToken _ct;
            private readonly ConcurrentQueue<string> _queue = new ConcurrentQueue<string>();
            private readonly SemaphoreSlim _signal = new SemaphoreSlim(0);

            public Outbox(IStageTransport transport, CancellationToken ct) { _transport = transport; _ct = ct; }

            public void Enqueue(string json)
            {
                _queue.Enqueue(json);
                _signal.Release();
            }

            public async Task RunAsync()
            {
                try
                {
                    while (true)
                    {
                        await _signal.WaitAsync(_ct).ConfigureAwait(false);
                        if (!_queue.TryDequeue(out var json)) continue;
                        await _transport.SendTextAsync(json, _ct).ConfigureAwait(false);
                    }
                }
                catch (OperationCanceledException) { /* the connection is over */ }
                catch (Exception) { /* the receive loop notices the lost connection */ }
            }
        }

        /// <summary>Commands in arrival order, handed out one at a time.</summary>
        private sealed class CommandQueue
        {
            private readonly ConcurrentQueue<StageCommand> _queue = new ConcurrentQueue<StageCommand>();
            private readonly SemaphoreSlim _signal = new SemaphoreSlim(0);
            private volatile bool _complete;

            public void Enqueue(StageCommand c)
            {
                _queue.Enqueue(c);
                _signal.Release();
            }

            public void Complete()
            {
                _complete = true;
                _signal.Release();
            }

            /// <summary>The next command, or null once the queue is complete and empty.</summary>
            public async Task<StageCommand> DequeueAsync(CancellationToken ct)
            {
                while (true)
                {
                    await _signal.WaitAsync(ct).ConfigureAwait(false);
                    if (_queue.TryDequeue(out var c)) return c;
                    if (_complete) return null;
                }
            }
        }
    }
}
