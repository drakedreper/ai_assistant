// The C# twin of validateLocator (packages/stage-core/src/assets/locator.ts). A locator is an engine-specific reference that
// comes from a manifest on disk, which is untrusted; the stage turns it into a file it reads, so this must refuse exactly
// what the daemon refuses. golden/locators.json holds a few thousand cases with the verdicts the TypeScript validator gives,
// and the tests replay every one of them. Read the comments in locator.ts for the reasoning behind each rule.
//
// Pure string logic (no System.IO.Path, no file system access), so a Windows-style locator is judged the same on any OS.
// Where .NET differs from JavaScript the difference is handled on purpose: "$" in a .NET regex also matches before a final
// newline (so \z is used), \d matches non-ASCII digits (so [0-9] is used), decodeURIComponent is strict about UTF-8 (so the
// percent-decoder here is too), and the JavaScript regex /\p{Cs}/u matches LONE surrogates only (so surrogate pairs are
// looked at as code points).
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace Mira.Stage
{
    public enum LocatorKind
    {
        Relative,
        Absolute,
        Url,
    }

    public sealed class LocatorOptions
    {
        /// <summary>Absolute content root (any separator style). Absolute locators are accepted only inside it.</summary>
        public string ContentRoot { get; set; }
        /// <summary>URL schemes accepted (lowercase, no colon). Default: asset, pack, https.</summary>
        public IReadOnlyCollection<string> AllowedSchemes { get; set; }
        /// <summary>
        /// Hosts a URL locator may use ("cdn.example.com", or "*.example.com"). When set, ONLY these hosts are accepted; when
        /// null, any public-looking DNS name is accepted and local, private and numeric hosts are refused.
        /// </summary>
        public IReadOnlyCollection<string> AllowedHosts { get; set; }
    }

    public sealed class LocatorCheck
    {
        public bool Ok { get; private set; }
        /// <summary>Only meaningful when Ok.</summary>
        public LocatorKind Kind { get; private set; }
        /// <summary>The locator in its stored form ("/" separators, no empty or dot segments, scheme lower-cased). Only when Ok.</summary>
        public string Normalized { get; private set; }
        /// <summary>Why it was refused. Only when not Ok.</summary>
        public string Reason { get; private set; }

        internal static LocatorCheck Accept(LocatorKind kind, string normalized) => new LocatorCheck { Ok = true, Kind = kind, Normalized = normalized };
        internal static LocatorCheck Refuse(string reason) => new LocatorCheck { Ok = false, Reason = reason };
    }

    public static class AssetLocator
    {
        public static readonly string[] DefaultAllowedSchemes = { "asset", "pack", "https" };
        public const int MaxLocator = 1024;
        /// <summary>At most this many percent-decodings are looked through; a string that still decodes after them is refused.</summary>
        public const int MaxDecodeRounds = 4;

        private static readonly Regex Scheme = new Regex(@"\A([A-Za-z][A-Za-z0-9+.\-]*):", RegexOptions.CultureInvariant);
        private static readonly Regex Drive = new Regex(@"\A[A-Za-z]:(?:[\\/]|\z)", RegexOptions.CultureInvariant);
        private static readonly Regex Unc = new Regex(@"\A[\\/]{2}", RegexOptions.CultureInvariant);
        private static readonly Regex ReservedStem = new Regex(
            @"\A(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)\z",
            RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
        private static readonly Regex UrlAuthority = new Regex(@"\A//([A-Za-z0-9.\-]+)(?::([0-9]{1,5}))?(?=/|\z)", RegexOptions.CultureInvariant);
        private static readonly Regex Credentials = new Regex(@"\A//[^/]*@", RegexOptions.CultureInvariant);
        private static readonly Regex HostLabel = new Regex(@"\A[a-z0-9\-]+\z", RegexOptions.CultureInvariant);
        private static readonly Regex NumericLabel = new Regex(@"\A(?:[0-9]+|0x[0-9a-f]*)\z", RegexOptions.CultureInvariant);
        private static readonly Regex LocalHost = new Regex(@"(?:\A|\.)(?:localhost|local|internal|intranet|lan|home|corp|home\.arpa)\z", RegexOptions.CultureInvariant);
        private static readonly Regex Slashes = new Regex("/+", RegexOptions.CultureInvariant);

        private static readonly HashSet<string> NetworkSchemes = new HashSet<string> { "http", "https", "ws", "wss", "ftp" };
        private static readonly char[] Separators = { '\\', '/' };
        private static readonly char[] WindowsForbidden = { '<', '>', '"', '|', '?', '*' };
        private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);

        private struct Form
        {
            public readonly string S;
            /// <summary>False for the string as written; true for anything derived from it (decoded or folded).</summary>
            public readonly bool Derived;
            public Form(string s, bool derived) { S = s; Derived = derived; }
        }

        // ------------------------------------------------------------------------------------------------- entry point

        public static LocatorCheck Validate(string locator, LocatorOptions opts = null)
        {
            opts = opts ?? new LocatorOptions();
            if (locator == null) return LocatorCheck.Refuse("locator must be a string");
            if (locator.Length == 0) return LocatorCheck.Refuse("locator is empty");
            if (locator.Length > MaxLocator) return LocatorCheck.Refuse("locator is too long");
            if (HasHidden(locator)) return LocatorCheck.Refuse("locator contains control characters");
            if (!string.Equals(locator.Trim(), locator, StringComparison.Ordinal)) return LocatorCheck.Refuse("locator has leading or trailing whitespace");
            // "\\host", "//host" and the mixed "\/host", "/\host" are all UNC prefixes on Windows
            if (Unc.IsMatch(locator)) return LocatorCheck.Refuse("network (UNC) paths are not allowed");

            var allowed = new HashSet<string>((opts.AllowedSchemes ?? DefaultAllowedSchemes).Select(s => s.ToLowerInvariant()));

            // Windows drive letters look like a one-letter scheme; decide that first.
            if (Drive.IsMatch(locator)) return CheckAbsolute(locator, opts);

            var m = Scheme.Match(locator);
            if (m.Success)
            {
                var scheme = m.Groups[1].Value.ToLowerInvariant();
                if (!allowed.Contains(scheme)) return LocatorCheck.Refuse("scheme \"" + scheme + ":\" is not allowed");
                var rest = locator.Substring(m.Length);
                return NetworkSchemes.Contains(scheme) ? CheckUrl(scheme, rest, locator, opts) : CheckPackPath(scheme, rest);
            }

            if (IsAbsolutePath(locator)) return CheckAbsolute(locator, opts);

            var n = NormalizeRelative(locator, out var problem);
            return problem == null ? LocatorCheck.Accept(LocatorKind.Relative, n) : LocatorCheck.Refuse(problem);
        }

        /// <summary>
        /// Whether a string holds a control, invisible-format, line or paragraph separator character or a lone surrogate.
        /// Validate refuses such a locator on this alone; it is public so that rule can be tested by itself (on .NET another
        /// rule happens to refuse a lone surrogate too, because string.Normalize throws on one, which Unity's runtime may not).
        /// </summary>
        public static bool ContainsHiddenCharacters(string s) => s != null && HasHidden(s);

        // ---------------------------------------------------------------------------------------- the relative path rules

        /// <summary>The problem with a relative path in ANY form a consumer could see, or null when every form is a plain relative path.</summary>
        public static string RelativePathProblem(string raw)
        {
            var forms = FormsOf(raw, out var error);
            if (forms == null) return error;
            foreach (var f in forms)
            {
                var p = PlainRelativeProblem(f);
                if (p != null) return p;
            }
            return null;
        }

        /// <summary>
        /// Check a relative path AND the form it is stored in. Normalising drops "." and empty segments, which can expose a
        /// leading encoded separator ("./%2fetc" becomes "%2fetc"), so the normalised string must pass on its own.
        /// </summary>
        private static string NormalizeRelative(string raw, out string problem)
        {
            problem = RelativePathProblem(raw);
            if (problem != null) return null;
            var segs = SegmentsOf(raw, out _);
            var normalized = string.Join("/", segs);
            if (!string.Equals(normalized, raw, StringComparison.Ordinal))
            {
                problem = RelativePathProblem(normalized);
                if (problem != null) return null;
            }
            return normalized;
        }

        private static string PlainRelativeProblem(Form f)
        {
            var s = f.S;
            if (HasHidden(s)) return Note("locator contains control characters", f.Derived);
            if (s.Length > 0 && (s[0] == '\\' || s[0] == '/')) return Note("absolute or network paths are not allowed here", f.Derived);
            if (f.Derived && s.IndexOf('\\') >= 0) return "an encoded backslash is not allowed";
            if (s.IndexOf(':') >= 0) return Note("\":\" is not allowed in a relative locator", f.Derived);
            var segs = SegmentsOf(s, out var traversal);
            if (traversal) return Note("path traversal (\"..\") is not allowed", f.Derived);
            if (segs.Count == 0) return Note("locator has no path", f.Derived);
            // Windows reserved device names (with or without an extension) and trailing dots/spaces are file-system tricks.
            foreach (var seg in segs)
            {
                var dot = seg.IndexOf('.');
                var stem = (dot < 0 ? seg : seg.Substring(0, dot)).TrimEnd();
                if (ReservedStem.IsMatch(stem)) return Note("reserved name \"" + (seg.Length > 40 ? seg.Substring(0, 40) : seg) + "\"", f.Derived);
                var last = seg[seg.Length - 1];
                if (last == '.' || last == ' ') return Note("segment ends with a dot or space", f.Derived);
                if (seg.IndexOfAny(WindowsForbidden) >= 0) return Note("segment has characters that are not allowed on Windows", f.Derived);
            }
            return null;
        }

        /// <summary>The same fixed-point look at a URL (or absolute path) as a whole: control characters, ".." segments and encoded backslashes in any form.</summary>
        private static string WholeProblem(string raw)
        {
            var forms = FormsOf(raw, out var error);
            if (forms == null) return error;
            foreach (var f in forms)
            {
                if (HasHidden(f.S)) return Note("locator contains control characters", f.Derived);
                if (f.Derived && f.S.IndexOf('\\') >= 0) return "an encoded backslash is not allowed";
                SegmentsOf(f.S, out var traversal);
                if (traversal) return Note("path traversal (\"..\") is not allowed", f.Derived);
            }
            return null;
        }

        private static string Note(string problem, bool derived) => derived ? problem + " (after decoding)" : problem;

        /// <summary>Segments after splitting on both separators; "." and empty segments are dropped, ".." is kept and reported.</summary>
        private static List<string> SegmentsOf(string path, out bool traversal)
        {
            traversal = false;
            var segs = new List<string>();
            foreach (var s in path.Split(Separators))
            {
                if (s.Length == 0 || s == ".") continue;
                if (s == "..") traversal = true;
                segs.Add(s);
            }
            return segs;
        }

        // --------------------------------------------------------------------------------- forms: folding and percent-decoding

        /// <summary>
        /// The string as written plus every form a consumer could derive from it: NFKC folding and percent-decoding, repeated
        /// until nothing changes. Bounded: MaxDecodeRounds decodings at most. Null (with an error) when it cannot be judged.
        /// </summary>
        private static List<Form> FormsOf(string raw, out string error)
        {
            error = null;
            var forms = new List<Form> { new Form(raw, false) };
            var cur = raw;
            for (var round = 0; ; round++)
            {
                string folded;
                try { folded = cur.Normalize(NormalizationForm.FormKC); }
                catch (ArgumentException)
                {
                    error = "locator is not valid Unicode text";
                    return null;
                }
                if (!string.Equals(folded, cur, StringComparison.Ordinal))
                {
                    forms.Add(new Form(folded, true));
                    cur = folded;
                }
                if (cur.IndexOf('%') < 0) break;
                if (round >= MaxDecodeRounds)
                {
                    error = "percent-encoding is nested too deeply";
                    return null;
                }
                var decoded = DecodeOnce(cur);
                if (decoded == null)
                {
                    error = "malformed percent-encoding";
                    return null;
                }
                forms.Add(new Form(decoded, true));
                cur = decoded;
            }
            return forms;
        }

        /// <summary>decodeURIComponent: every %XX is a byte, runs of them must be well-formed UTF-8; null when anything is malformed.</summary>
        private static string DecodeOnce(string s)
        {
            var sb = new StringBuilder(s.Length);
            var run = new List<byte>();
            var i = 0;
            while (i < s.Length)
            {
                if (s[i] != '%')
                {
                    sb.Append(s[i]);
                    i++;
                    continue;
                }
                run.Clear();
                while (i < s.Length && s[i] == '%')
                {
                    if (i + 2 >= s.Length) return null;
                    var hi = Hex(s[i + 1]);
                    var lo = Hex(s[i + 2]);
                    if (hi < 0 || lo < 0) return null;
                    run.Add((byte)((hi << 4) | lo));
                    i += 3;
                }
                try { sb.Append(StrictUtf8.GetString(run.ToArray())); }
                catch (DecoderFallbackException) { return null; }
            }
            return sb.ToString();
        }

        private static int Hex(char c)
        {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return c - 'a' + 10;
            if (c >= 'A' && c <= 'F') return c - 'A' + 10;
            return -1;
        }

        /// <summary>
        /// Control characters (Cc), invisible format characters (Cf: bidi marks and overrides, zero-width), line and paragraph
        /// separators (Zl, Zp) and lone surrogates (Cs). A surrogate PAIR is one code point and is judged as that code point.
        /// </summary>
        private static bool HasHidden(string s)
        {
            for (var i = 0; i < s.Length; i++)
            {
                var c = s[i];
                if (char.IsHighSurrogate(c))
                {
                    if (i + 1 < s.Length && char.IsLowSurrogate(s[i + 1]))
                    {
                        if (IsSupplementaryFormat(char.ConvertToUtf32(c, s[i + 1]))) return true;
                        i++;
                        continue;
                    }
                    return true; // a lone high surrogate
                }
                if (char.IsLowSurrogate(c)) return true; // a lone low surrogate
                switch (CharUnicodeInfo.GetUnicodeCategory(c))
                {
                    case UnicodeCategory.Control:
                    case UnicodeCategory.Format:
                    case UnicodeCategory.LineSeparator:
                    case UnicodeCategory.ParagraphSeparator:
                        return true;
                }
            }
            return false;
        }

        /// <summary>
        /// The format characters (Cf) outside the Basic Multilingual Plane, listed here so the answer does not depend on how
        /// much of Unicode the runtime's category tables know (Unity's Mono and IL2CPP differ from .NET in that).
        /// </summary>
        private static bool IsSupplementaryFormat(int cp) =>
            cp == 0x110BD || cp == 0x110CD
            || (cp >= 0x13430 && cp <= 0x1343F)
            || (cp >= 0x1BCA0 && cp <= 0x1BCA3)
            || (cp >= 0x1D173 && cp <= 0x1D17A)
            || cp == 0xE0001
            || (cp >= 0xE0020 && cp <= 0xE007F);

        // ----------------------------------------------------------------------------------------------- the other kinds

        private static bool IsAbsolutePath(string s) => s.StartsWith("/", StringComparison.Ordinal) || s.StartsWith("\\", StringComparison.Ordinal) || Drive.IsMatch(s);

        /// <summary>Canonical comparison form: forward slashes, no trailing slash, lower-cased when it is a drive path (Windows is case-insensitive).</summary>
        private static string CanonAbs(string p)
        {
            var slashed = Slashes.Replace(p.Replace('\\', '/'), "/");
            var trimmed = slashed.Length > 1 && slashed.EndsWith("/", StringComparison.Ordinal) ? slashed.Substring(0, slashed.Length - 1) : slashed;
            return Drive.IsMatch(trimmed) ? trimmed.ToLowerInvariant() : trimmed;
        }

        /// <summary>asset: / pack: (and any other allowed non-network scheme): what follows is a plain relative path inside the content pack.</summary>
        private static LocatorCheck CheckPackPath(string scheme, string rest)
        {
            if (rest.Length > 0 && (rest[0] == '\\' || rest[0] == '/'))
            {
                return LocatorCheck.Refuse(scheme + ": locators are plain relative paths such as \"" + scheme + ":props/chair\"; a leading \"/\" or \"//\" (a network-style path) is not allowed");
            }
            var n = NormalizeRelative(rest, out var problem);
            return problem == null ? LocatorCheck.Accept(LocatorKind.Url, scheme + ":" + n) : LocatorCheck.Refuse(problem);
        }

        private static bool HostMatches(string host, string entry)
        {
            var e = DropOneTrailingDot(entry.ToLowerInvariant());
            if (e.StartsWith("*.", StringComparison.Ordinal)) return host.EndsWith(e.Substring(1), StringComparison.Ordinal) && host.Length > e.Length - 1;
            return string.Equals(host, e, StringComparison.Ordinal);
        }

        /// <summary>JavaScript's .replace(/\.$/, ""): ONE trailing dot, not all of them (TrimEnd would accept "example.com..").</summary>
        private static string DropOneTrailingDot(string s) => s.EndsWith(".", StringComparison.Ordinal) ? s.Substring(0, s.Length - 1) : s;

        /// <summary>Why a host may not be fetched by a stage, or null when it is fine.</summary>
        private static string HostProblem(string rawHost, IReadOnlyCollection<string> allowedHosts)
        {
            var host = DropOneTrailingDot(rawHost.ToLowerInvariant());
            if (allowedHosts != null)
            {
                return allowedHosts.Any(e => HostMatches(host, e)) ? null : "host \"" + (host.Length > 80 ? host.Substring(0, 80) : host) + "\" is not on the allowed list";
            }
            var labels = host.Split('.');
            if (labels.Any(l => l.Length == 0 || l.Length > 63 || !HostLabel.IsMatch(l) || l.StartsWith("-", StringComparison.Ordinal) || l.EndsWith("-", StringComparison.Ordinal))) return "the host name is not valid";
            if (labels.Length < 2) return "single-label (intranet) hosts are not allowed";
            // a last label that is a number (decimal, or 0x hex) makes browsers and resolvers read the whole host as an IPv4 address
            if (NumericLabel.IsMatch(labels[labels.Length - 1])) return "IP-address hosts are not allowed";
            if (LocalHost.IsMatch(host)) return "local and intranet hosts are not allowed";
            return null;
        }

        private static LocatorCheck CheckUrl(string scheme, string rest, string locator, LocatorOptions opts)
        {
            if (Credentials.IsMatch(rest)) return LocatorCheck.Refuse("credentials in a URL are not allowed");
            if (rest.StartsWith("///", StringComparison.Ordinal)) return LocatorCheck.Refuse("empty authority is not allowed");
            var m = UrlAuthority.Match(rest);
            if (!m.Success) return LocatorCheck.Refuse(scheme + " locator needs a host");
            if (m.Groups[2].Success && long.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture) > 65535) return LocatorCheck.Refuse("the port is not valid");
            var bad = HostProblem(m.Groups[1].Value, opts.AllowedHosts);
            if (bad != null) return LocatorCheck.Refuse(bad);
            var problem = WholeProblem(rest.Substring(m.Length));
            if (problem != null) return LocatorCheck.Refuse(problem);
            return LocatorCheck.Accept(LocatorKind.Url, locator);
        }

        private static LocatorCheck CheckAbsolute(string locator, LocatorOptions opts)
        {
            if (string.IsNullOrEmpty(opts.ContentRoot)) return LocatorCheck.Refuse("absolute paths are not allowed without a content root");
            var whole = WholeProblem(locator);
            if (whole != null) return LocatorCheck.Refuse(whole);
            var root = CanonAbs(opts.ContentRoot);
            var full = CanonAbs(locator);
            if (!string.Equals(full, root, StringComparison.Ordinal) && !full.StartsWith(root + "/", StringComparison.Ordinal)) return LocatorCheck.Refuse("absolute path is outside the content root");
            if (string.Equals(full, root, StringComparison.Ordinal)) return LocatorCheck.Refuse("locator points at the content root itself");
            // what lies below the root follows the relative-path rules like any other path (reserved names, ":", trailing dots...)
            var below = RelativePathProblem(full.Substring(root.Length + 1));
            if (below != null) return LocatorCheck.Refuse(below);
            var normalized = Slashes.Replace(locator.Replace('\\', '/'), "/");
            var again = WholeProblem(normalized);
            if (again != null) return LocatorCheck.Refuse(again);
            return LocatorCheck.Accept(LocatorKind.Absolute, normalized);
        }
    }
}
