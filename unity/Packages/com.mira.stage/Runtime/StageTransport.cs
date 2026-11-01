// The wire under the client: one WebSocket to /ws/stage. The interface exists so the client can be tested without a
// network; WebSocketStageTransport is the real one.
using System;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Mira.Stage
{
    /// <summary>One message from the daemon.</summary>
    public sealed class StageMessage
    {
        public bool IsText { get; set; }
        public string Text { get; set; }
        public byte[] Binary { get; set; }
        /// <summary>The peer closed the connection (or it was lost); there is nothing more to read.</summary>
        public bool Closed { get; set; }
        public string CloseReason { get; set; }
    }

    /// <summary>The daemon refused the upgrade (401 wrong or missing token, 403 stage off or foreign Host, 409 another stage is connected).</summary>
    public sealed class StageRefusedException : Exception
    {
        public int Status { get; }
        public StageRefusedException(int status, string message) : base(message) { Status = status; }
    }

    public interface IStageTransport : IDisposable
    {
        /// <summary>Open the socket with `Authorization: Bearer token` and no Origin. Throws StageRefusedException when refused.</summary>
        Task ConnectAsync(Uri url, string bearerToken, CancellationToken ct);
        Task SendTextAsync(string text, CancellationToken ct);
        /// <summary>The next message; a Closed message once the connection is over.</summary>
        Task<StageMessage> ReceiveAsync(CancellationToken ct);
        Task CloseAsync(string reason);
    }

    public sealed class WebSocketStageTransport : IStageTransport
    {
        private readonly int _maxMessageBytes;
        private ClientWebSocket _socket;

        public WebSocketStageTransport(int maxMessageBytes = 8 * 1024 * 1024) { _maxMessageBytes = maxMessageBytes; }

        public async Task ConnectAsync(Uri url, string bearerToken, CancellationToken ct)
        {
            if (!string.IsNullOrEmpty(url.Query)) throw new ArgumentException("the stage URL must not carry a query string (the daemon refuses one)");
            var socket = new ClientWebSocket();
            // An engine is not a browser: no Origin. The token travels in the header, never in the URL.
            socket.Options.SetRequestHeader("Authorization", "Bearer " + bearerToken);
            socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
            socket.Options.Proxy = null;
            try
            {
                await socket.ConnectAsync(url, ct).ConfigureAwait(false);
            }
            catch (WebSocketException e)
            {
                socket.Dispose();
                var status = RefusalStatus(e);
                if (status > 0) throw new StageRefusedException(status, "the daemon answered HTTP " + status + " to the stage upgrade");
                throw;
            }
            _socket = socket;
        }

        public async Task SendTextAsync(string text, CancellationToken ct)
        {
            var bytes = Encoding.UTF8.GetBytes(text);
            await _socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, ct).ConfigureAwait(false);
        }

        public async Task<StageMessage> ReceiveAsync(CancellationToken ct)
        {
            var buffer = new byte[64 * 1024];
            using (var assembled = new MemoryStream())
            {
                while (true)
                {
                    WebSocketReceiveResult r;
                    try
                    {
                        r = await _socket.ReceiveAsync(new ArraySegment<byte>(buffer), ct).ConfigureAwait(false);
                    }
                    catch (WebSocketException e)
                    {
                        return new StageMessage { Closed = true, CloseReason = "connection lost: " + e.Message };
                    }
                    if (r.MessageType == WebSocketMessageType.Close)
                    {
                        try { await _socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None).ConfigureAwait(false); } catch (Exception) { /* already gone */ }
                        return new StageMessage { Closed = true, CloseReason = r.CloseStatusDescription ?? r.CloseStatus?.ToString() ?? "closed" };
                    }
                    assembled.Write(buffer, 0, r.Count);
                    if (assembled.Length > _maxMessageBytes)
                    {
                        await CloseAsync("message too large").ConfigureAwait(false);
                        return new StageMessage { Closed = true, CloseReason = "a message above " + _maxMessageBytes + " bytes" };
                    }
                    if (!r.EndOfMessage) continue;
                    var data = assembled.ToArray();
                    return r.MessageType == WebSocketMessageType.Text
                        ? new StageMessage { IsText = true, Text = Encoding.UTF8.GetString(data) }
                        : new StageMessage { Binary = data };
                }
            }
        }

        public async Task CloseAsync(string reason)
        {
            var s = _socket;
            if (s == null) return;
            try
            {
                if (s.State == WebSocketState.Open || s.State == WebSocketState.CloseReceived)
                {
                    using (var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2)))
                        await s.CloseAsync(WebSocketCloseStatus.NormalClosure, reason, cts.Token).ConfigureAwait(false);
                }
            }
            catch (Exception) { /* closing is best effort */ }
        }

        public void Dispose()
        {
            _socket?.Dispose();
            _socket = null;
        }

        /// <summary>
        /// The HTTP status of a refused upgrade, or 0. .NET puts it in the message ("The server returned status code '401' when
        /// status code '101' was expected."); Unity's Mono says something close to it, so match on the number, not the wording.
        /// </summary>
        public static int RefusalStatus(Exception e)
        {
            for (var x = e; x != null; x = x.InnerException)
            {
                var m = Regex.Match(x.Message ?? string.Empty, @"\b(4\d\d|5\d\d)\b");
                if (m.Success && (x.Message.IndexOf("status", StringComparison.OrdinalIgnoreCase) >= 0 || x.Message.IndexOf("HTTP", StringComparison.OrdinalIgnoreCase) >= 0))
                    return int.Parse(m.Groups[1].Value);
            }
            return 0;
        }
    }
}
