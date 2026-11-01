// Where the stage finds the daemon's address and its stage token. The token is a secret: it comes from the environment
// (MIRA_STAGE_TOKEN) or from the daemon's own secrets.json on this PC, and is never logged, printed or put in a URL.
using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json.Linq;

namespace Mira.Stage
{
    public sealed class StageCredentials
    {
        public Uri Url { get; set; }
        /// <summary>Null when no token was found.</summary>
        public string Token { get; set; }
        /// <summary>Where the token came from ("MIRA_STAGE_TOKEN", or the path of secrets.json). Never the token itself.</summary>
        public string TokenSource { get; set; }
    }

    public static class StageCredentialsResolver
    {
        public const string UrlVariable = "MIRA_STAGE_URL";
        public const string TokenVariable = "MIRA_STAGE_TOKEN";
        public const string DataDirVariable = "MIRA_DATA_DIR";

        /// <summary>
        /// MIRA_STAGE_URL (default ws://127.0.0.1:7421/ws/stage), MIRA_STAGE_TOKEN, else the stageToken in secrets.json of
        /// MIRA_DATA_DIR, else of the daemon's default data directory (%APPDATA%\ai-assistant on Windows, otherwise
        /// $XDG_DATA_HOME or ~/.local/share, then /ai-assistant). The environment and the file reader can be replaced for tests.
        /// </summary>
        public static StageCredentials Resolve(Func<string, string> env = null, Func<string, string> readFile = null, bool? isWindows = null)
        {
            env = env ?? Environment.GetEnvironmentVariable;
            readFile = readFile ?? ReadFileOrNull;
            var windows = isWindows ?? (Path.DirectorySeparatorChar == '\\');

            var url = ParseUrl(env(UrlVariable));
            var fromEnv = env(TokenVariable)?.Trim();
            if (!string.IsNullOrEmpty(fromEnv)) return new StageCredentials { Url = url, Token = fromEnv, TokenSource = TokenVariable };

            var dir = env(DataDirVariable);
            if (string.IsNullOrWhiteSpace(dir))
            {
                if (windows)
                {
                    var appData = env("APPDATA");
                    if (!string.IsNullOrWhiteSpace(appData)) dir = Path.Combine(appData, "ai-assistant");
                }
                else
                {
                    var xdg = env("XDG_DATA_HOME");
                    var home = env("HOME");
                    if (!string.IsNullOrWhiteSpace(xdg)) dir = Path.Combine(xdg, "ai-assistant");
                    else if (!string.IsNullOrWhiteSpace(home)) dir = Path.Combine(home, ".local", "share", "ai-assistant");
                }
            }
            if (string.IsNullOrWhiteSpace(dir)) return new StageCredentials { Url = url };

            var file = Path.Combine(dir, "secrets.json");
            var text = readFile(file);
            if (text == null) return new StageCredentials { Url = url };
            try
            {
                var token = (JObject.Parse(text).Value<string>("stageToken") ?? string.Empty).Trim();
                if (token.Length >= 40) return new StageCredentials { Url = url, Token = token, TokenSource = file };
            }
            catch (Newtonsoft.Json.JsonException)
            {
                // an unreadable secrets file is the same as none
            }
            return new StageCredentials { Url = url };
        }

        /// <summary>The URL must be ws:// on this PC (the daemon is loopback only), without credentials or a query string.</summary>
        public static Uri ParseUrl(string value)
        {
            var text = string.IsNullOrWhiteSpace(value) ? "ws://127.0.0.1:" + StageProtocol.DefaultPort + StageProtocol.WebSocketPath : value.Trim();
            if (!Uri.TryCreate(text, UriKind.Absolute, out var uri)) throw new ArgumentException("MIRA_STAGE_URL is not a URL");
            if (uri.Scheme != "ws") throw new ArgumentException("MIRA_STAGE_URL must be ws:// (the daemon is loopback only)");
            var loopback = new HashSet<string> { "127.0.0.1", "localhost", "[::1]", "::1" };
            if (!loopback.Contains(uri.Host) && !loopback.Contains(uri.DnsSafeHost)) throw new ArgumentException("MIRA_STAGE_URL must point at this PC (127.0.0.1 or localhost)");
            if (!string.IsNullOrEmpty(uri.UserInfo)) throw new ArgumentException("MIRA_STAGE_URL must not carry credentials");
            if (!string.IsNullOrEmpty(uri.Query)) throw new ArgumentException("MIRA_STAGE_URL must not carry a query string");
            return uri;
        }

        private static string ReadFileOrNull(string path)
        {
            try { return File.Exists(path) ? File.ReadAllText(path) : null; }
            catch (IOException) { return null; }
            catch (UnauthorizedAccessException) { return null; }
        }
    }
}
