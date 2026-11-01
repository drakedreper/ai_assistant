using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Xunit;

namespace Mira.Stage.Tests
{
    /// <summary>
    /// The C# validator against the TypeScript one: golden/locators.json holds every case of the corpus with the verdict that
    /// packages/stage-core/src/assets/locator.ts gives, and a case the port judges differently is a hole in the Unity stage
    /// or a locator the daemon would hand it and it would refuse.
    /// </summary>
    public class LocatorTests
    {
        private static readonly Dictionary<string, string> Roots = new Dictionary<string, string>
        {
            ["win"] = @"C:\Content\Assets",
            ["posix"] = "/srv/content",
        };

        private sealed class Case
        {
            public string Locator;
            public string Root;
            public string[] Hosts;
            public bool Ok;
            public string Kind;
            public string Normalized;
        }

        private static List<Case> Corpus()
        {
            var list = new List<Case>();
            foreach (var t in JArray.Parse(TestPaths.ReadGolden("locators.json")))
            {
                // a locator with a LONE surrogate is stored as its UTF-16 code units (lu): as a JSON string it would be
                // read back as U+FFFD, which is harmless text and would make the case meaningless
                var units = t["lu"]?.Values<int>().ToArray();
                list.Add(new Case
                {
                    Locator = units != null ? new string(units.Select(u => (char)u).ToArray()) : t.Value<string>("l"),
                    Root = t.Value<string>("r"),
                    Hosts = t["h"]?.Values<string>().ToArray(),
                    Ok = t.Value<bool>("ok"),
                    Kind = t.Value<string>("kind"),
                    Normalized = t.Value<string>("n"),
                });
            }
            return list;
        }

        private static LocatorOptions OptionsOf(Case c) => new LocatorOptions { ContentRoot = Roots.TryGetValue(c.Root, out var r) ? r : null, AllowedHosts = c.Hosts };

        private static string Show(string s) => JsonConvert.SerializeObject(s);

        [Fact]
        public void EveryCaseOfTheTypeScriptCorpusGetsTheSameVerdictKindAndNormalisedForm()
        {
            var cases = Corpus();
            Assert.True(cases.Count > 3000, cases.Count + " cases");
            Assert.True(cases.Count(c => c.Ok) > 600);
            Assert.True(cases.Count(c => !c.Ok) > 1500);

            var wrong = new List<string>();
            foreach (var c in cases)
            {
                var got = AssetLocator.Validate(c.Locator, OptionsOf(c));
                if (got.Ok != c.Ok)
                {
                    wrong.Add(Show(c.Locator) + " root=" + c.Root + " expected ok=" + c.Ok + ", got ok=" + got.Ok + (got.Ok ? "" : " (" + got.Reason + ")"));
                    continue;
                }
                if (!c.Ok)
                {
                    if (string.IsNullOrEmpty(got.Reason)) wrong.Add(Show(c.Locator) + " was refused without a reason");
                    continue;
                }
                var kind = got.Kind.ToString().ToLowerInvariant();
                if (kind != c.Kind || got.Normalized != c.Normalized)
                {
                    wrong.Add(Show(c.Locator) + " root=" + c.Root + " expected " + c.Kind + " " + Show(c.Normalized) + ", got " + kind + " " + Show(got.Normalized));
                }
            }
            Assert.True(wrong.Count == 0, wrong.Count + " of " + cases.Count + " cases differ from the TypeScript validator; first: " + string.Join("  |  ", wrong.Take(8)));
        }

        [Fact]
        public void TheCorpusIsNotVacuous_EveryKindOfLocatorAndEveryKindOfRefusalAppears()
        {
            var cases = Corpus();
            foreach (var kind in new[] { "relative", "url", "absolute" }) Assert.Contains(cases, c => c.Ok && c.Kind == kind);
            foreach (var root in new[] { "none", "win", "posix" }) Assert.Contains(cases, c => c.Root == root);
            Assert.Contains(cases, c => c.Hosts != null);
            // the verdicts really are the validator's, not a constant: hostile and ordinary cases both exist for the same shape
            Assert.Contains(cases, c => c.Ok && c.Locator.StartsWith("asset:", StringComparison.Ordinal));
            Assert.Contains(cases, c => !c.Ok && c.Locator.StartsWith("asset:", StringComparison.Ordinal));
        }

        [Theory]
        [InlineData("bases/vrm1/composed.vrm", "relative", "bases/vrm1/composed.vrm")]
        [InlineData("asset:props/chair", "url", "asset:props/chair")]
        [InlineData("ASSET:props\\\\chair/./x.glb", "url", "asset:props/chair/x.glb")]
        [InlineData("./props//chair", "relative", "props/chair")]
        [InlineData("props\\chair", "relative", "props/chair")]
        public void OrdinaryLocatorsAreAcceptedAndNormalised(string locator, string kind, string normalized)
        {
            var r = AssetLocator.Validate(locator);
            Assert.True(r.Ok, r.Reason);
            Assert.Equal(kind, r.Kind.ToString().ToLowerInvariant());
            Assert.Equal(normalized, r.Normalized);
        }

        [Theory]
        [InlineData("../x")]
        [InlineData("a/../../x")]
        [InlineData("%2e%2e/x")]
        [InlineData("%252e%252e/x")]
        [InlineData("\uff0e\uff0e/x")]
        [InlineData("/etc/passwd")]
        [InlineData("C:\\Windows\\win.ini")]
        [InlineData("\\\\server\\share\\x")]
        [InlineData("asset://evil/share/x")]
        [InlineData("file:///etc/passwd")]
        [InlineData("con")]
        [InlineData("x.")]
        [InlineData("a:b")]
        [InlineData("a\u0000b")]
        [InlineData("a\u202eb")]
        [InlineData("a\U000E0041b")]
        [InlineData("https://127.0.0.1/x")]
        [InlineData("https://example.com../x")]
        [InlineData("")]
        public void HostileLocatorsAreRefused(string locator)
        {
            Assert.False(AssetLocator.Validate(locator).Ok, locator);
        }

        /// <summary>
        /// The text for a code point; for a surrogate code unit (D800 to DFFF) the lone char. Built from numbers on purpose: the
        /// source then holds no invisible or line-separator characters (U+2028 inside a C# literal is a newline to the compiler).
        /// </summary>
        private static string Cp(int cp) => cp >= 0xD800 && cp <= 0xDFFF ? ((char)cp).ToString() : char.ConvertFromUtf32(cp);

        private static string Around(int cp) => "a" + Cp(cp) + "b";

        [Fact]
        public void ALoneSurrogateIsRefusedButAPairIsJustACharacter()
        {
            // built in code: xunit's InlineData cannot carry a lone surrogate (it comes through as U+FFFD)
            Assert.False(AssetLocator.Validate(Around(0xD800)).Ok);
            Assert.False(AssetLocator.Validate(Around(0xDC00)).Ok);
            Assert.False(AssetLocator.Validate("a" + Cp(0xD800)).Ok);
            Assert.False(AssetLocator.Validate("asset:a" + Cp(0xDC00)).Ok);
            Assert.False(AssetLocator.Validate(Cp(0x1F600) + Cp(0xD83D)).Ok); // a pair followed by a lone high surrogate
            var emoji = Cp(0x1F600);
            Assert.True(AssetLocator.Validate("props/" + emoji + "/a.glb").Ok);
            // the fixture really carries lone surrogates (otherwise the corpus test above proves nothing about them)
            Assert.True(Corpus().Count(c => c.Locator.Any(char.IsSurrogate) && !c.Ok && !c.Locator.Contains(emoji)) >= 10);
        }

        [Fact]
        public void TheHiddenCharacterRuleStandsOnItsOwn_NotOnWhatNormalizeHappensToThrowOn()
        {
            // control, invisible format, line and paragraph separators, supplementary-plane format characters, lone surrogates
            var hidden = new[] { 0x0, 0x7, 0x7F, 0x85, 0xAD, 0x200B, 0x200D, 0x202E, 0x2066, 0xFEFF, 0x2028, 0x2029, 0xE0041, 0xE0001, 0x1D173, 0x110BD, 0x13430, 0xD800, 0xDBFF, 0xDC00, 0xDFFF };
            foreach (var cp in hidden) Assert.True(AssetLocator.ContainsHiddenCharacters(Around(cp)), "U+" + cp.ToString("X4"));
            Assert.True(AssetLocator.ContainsHiddenCharacters("a" + Cp(0xD800))); // a trailing lone high surrogate
            Assert.True(AssetLocator.ContainsHiddenCharacters(Cp(0xDC00) + "a")); // a leading lone low surrogate
            Assert.True(AssetLocator.ContainsHiddenCharacters(Cp(0x1F600) + Cp(0xD83D))); // a pair, then a lone high surrogate
            Assert.True(AssetLocator.ContainsHiddenCharacters(Cp(0xDE00) + Cp(0x1F600))); // a lone low surrogate, then a pair
            // ordinary text, including a surrogate pair and a variation selector (Mn, not Cf), is not hidden
            foreach (var cp in new[] { 0x61, 0xE9, 0x8863, 0x30B7, 0x1F600, 0xE0100, 0x20, 0x2E }) Assert.False(AssetLocator.ContainsHiddenCharacters(Around(cp)), "U+" + cp.ToString("X4"));
            Assert.False(AssetLocator.ContainsHiddenCharacters(string.Empty));
            Assert.False(AssetLocator.ContainsHiddenCharacters(null));
        }

        [Fact]
        public void NullIsRefusedAndAnOverlongLocatorToo()
        {
            Assert.False(AssetLocator.Validate(null).Ok);
            Assert.True(AssetLocator.Validate(new string('x', 1024)).Ok);
            Assert.False(AssetLocator.Validate(new string('x', 1025)).Ok);
        }

        // ------------------------------------------------------------------------------------------------ the resolver

        private static string Root() => Path.Combine(Path.GetTempPath(), "mira-content-test");

        private static string[] RecordedLocators()
        {
            var found = new List<string>();
            foreach (var file in TestPaths.GoldenFiles("recorded", "*.json").Where(f => !f.EndsWith("manifest.json", StringComparison.Ordinal)))
            {
                foreach (var t in JObject.Parse(File.ReadAllText(file)).SelectTokens("$..locator")) found.Add(t.Value<string>());
            }
            return found.Distinct().ToArray();
        }

        [Fact]
        public void EveryLocatorTheRealDaemonSentInTheRecordedTrafficResolvesInsideTheContentFolder()
        {
            var locators = RecordedLocators();
            Assert.True(locators.Length >= 3, "the recording holds " + locators.Length + " locators");
            var root = Path.GetFullPath(Root());
            foreach (var locator in locators)
            {
                var r = StageContent.Resolve(Root(), locator);
                Assert.True(r.Ok, locator + ": " + r.Reason);
                Assert.StartsWith(root + Path.DirectorySeparatorChar, r.Path, StringComparison.Ordinal);
            }
            // and they are the shapes the seed catalog uses
            Assert.Contains("bases/vrm1/composed.vrm", locators);
        }

        [Fact]
        public void ALocatorBecomesAFileInsideTheContentFolder()
        {
            var root = Path.GetFullPath(Root());
            string Expect(params string[] parts) => Path.Combine(new[] { root }.Concat(parts).ToArray());

            Assert.Equal(Expect("bases", "vrm1", "composed.vrm"), StageContent.Resolve(Root(), "bases/vrm1/composed.vrm").Path);
            Assert.Equal(Expect("props", "chair"), StageContent.Resolve(Root(), "asset:props/chair").Path);
            Assert.Equal(Expect("main", "hair", "braid"), StageContent.Resolve(Root(), "pack:main/hair/braid").Path);
            Assert.Equal(Expect("a", "b.vrm"), StageContent.Resolve(Root(), "./a//b.vrm").Path);
        }

        [Fact]
        public void PercentEscapesAreNotDecoded_ANameIsLiteral()
        {
            var r = StageContent.Resolve(Root(), "props/My%20Chair/a.glb");
            Assert.True(r.Ok, r.Reason);
            Assert.EndsWith(Path.Combine("props", "My%20Chair", "a.glb"), r.Path, StringComparison.Ordinal);
        }

        [Theory]
        [InlineData("../x")]
        [InlineData("a/../../x")]
        [InlineData("a\\..\\..\\x")]
        [InlineData("%2e%2e/x")]
        [InlineData("asset:../x")]
        [InlineData("/etc/passwd")]
        [InlineData("C:\\Windows\\win.ini")]
        [InlineData("\\\\server\\share\\x")]
        [InlineData("asset:/etc/passwd")]
        [InlineData("..")]
        [InlineData(".")]
        public void ALocatorCannotLeaveTheContentFolder(string locator)
        {
            var r = StageContent.Resolve(Root(), locator);
            Assert.False(r.Ok, locator + " -> " + r.Path);
            Assert.Null(r.Path);
            Assert.False(string.IsNullOrEmpty(r.Reason));
        }

        [Fact]
        public void ARemoteLocatorIsReportedAsRemoteNotAsUnsafe()
        {
            var r = StageContent.Resolve(Root(), "https://cdn.example.com/a.vrm");
            Assert.False(r.Ok);
            Assert.True(r.Remote);
            var local = StageContent.Resolve(Root(), "https://127.0.0.1/a.vrm");
            Assert.False(local.Ok);
            Assert.False(local.Remote); // unsafe, not merely unsupported
        }

        [Theory]
        [InlineData(null)]
        [InlineData("")]
        [InlineData("   ")]
        [InlineData("relative/folder")]
        public void WithoutAnAbsoluteContentFolderNothingResolves(string root)
        {
            var r = StageContent.Resolve(root, "bases/vrm1/composed.vrm");
            Assert.False(r.Ok);
            Assert.Contains(StageContent.ContentDirVariable, r.Reason);
        }

        // ------------------------------------------------------------------------------------------------- the content root

        private static Func<string, string> Env(params string[] pairs)
        {
            var d = new Dictionary<string, string>();
            for (var i = 0; i + 1 < pairs.Length; i += 2) d[pairs[i]] = pairs[i + 1];
            return k => d.TryGetValue(k, out var v) ? v : null;
        }

        [Fact]
        public void TheContentFolderComesFromTheEnvironmentFirst()
        {
            Assert.Equal("/data/mira-content", StageContent.ResolveRoot(Env("MIRA_CONTENT_DIR", "/data/mira-content", "HOME", "/home/u"), false));
            Assert.Equal("D:\\Models\\Mira", StageContent.ResolveRoot(Env("MIRA_CONTENT_DIR", " D:\\Models\\Mira ", "USERPROFILE", "C:\\Users\\u"), true));
        }

        [Fact]
        public void WithoutTheVariableItIsMiraContentInTheHomeFolder()
        {
            var linux = StageContent.ResolveRoot(Env("HOME", "/home/u"), false);
            Assert.Equal("/home/u/Mira/content", linux.Replace('\\', '/'));
            var windows = StageContent.ResolveRoot(Env("USERPROFILE", "C:\\Users\\u", "HOME", "/ignored"), true);
            Assert.Equal("C:/Users/u/Mira/content", windows.Replace('\\', '/'));
        }

        [Fact]
        public void ARelativeOrMissingFolderIsNullSoTheCallerCanSaySoInsteadOfGuessing()
        {
            Assert.Null(StageContent.ResolveRoot(Env("MIRA_CONTENT_DIR", "relative/dir", "HOME", "/home/u"), false));
            Assert.Null(StageContent.ResolveRoot(Env("MIRA_CONTENT_DIR", "C:relative", "USERPROFILE", "C:\\Users\\u"), true));
            Assert.Null(StageContent.ResolveRoot(Env(), false));
            Assert.Null(StageContent.ResolveRoot(Env("HOME", "not/absolute"), false));
        }
    }
}
