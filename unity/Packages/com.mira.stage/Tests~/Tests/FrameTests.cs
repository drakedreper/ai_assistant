using System;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using Xunit;

namespace Mira.Stage.Tests
{
    public class FrameTests
    {
        [Theory]
        [InlineData("", 0x811c9dc5u)]
        [InlineData("a", 0xe40c292cu)]
        [InlineData("foobar", 0xbf9cf968u)]
        public void Fnv1a32_MatchesTheStandardTestVectors(string text, uint expected) => Assert.Equal(expected, StageFrames.Fnv1a32(text));

        [Fact]
        public void TheUtteranceIdHashIsTheOneTheTypeScriptEncoderWrote()
        {
            // The recorded frames come from the REAL daemon (packages/stage-core encoder). Their header hash must be the FNV-1a of
            // the id of one of the recorded perform.speak commands: the same function in both languages.
            var index = JArray.Parse(TestPaths.ReadGolden("recorded/frames/index.json"));
            Assert.True(index.Count >= 4, "recorded frames are missing: run scripts/record-stage-golden.ts");
            var ids = TestPaths.GoldenFiles("recorded", "*-perform.speak.json").Select(f => JObject.Parse(File.ReadAllText(f)).Value<string>("utteranceId")).ToArray();
            Assert.NotEmpty(ids);
            foreach (var entry in index)
            {
                var hash = entry.Value<uint>("utteranceIdHash");
                Assert.Contains(ids, id => StageFrames.Fnv1a32(id) == hash);
            }
        }

        [Fact]
        public void EveryRecordedFrameDecodes_AndCarriesAudioOrFaceInTheRightShape()
        {
            var index = JArray.Parse(TestPaths.ReadGolden("recorded/frames/index.json"));
            var audio = 0;
            var face = 0;
            foreach (var entry in index)
            {
                var bytes = Convert.FromBase64String(TestPaths.ReadGolden("recorded/frames/" + entry.Value<string>("file")).Trim());
                var r = StageFrames.Decode(bytes);
                Assert.True(r.Ok, entry.Value<string>("file") + ": " + r.Error);
                Assert.Equal(entry.Value<double>("tStartMs"), r.Frame.TStartMs, 6);
                Assert.Equal(entry.Value<uint>("utteranceIdHash"), r.Frame.UtteranceIdHash);
                if (r.Frame.Kind == FrameKind.Audio)
                {
                    audio++;
                    var a = StageFrames.ToAudio(r.Frame);
                    Assert.Equal(0, a.Pcm.Length % 2);
                    Assert.InRange(a.DurationMs, 1, 2000);
                }
                else
                {
                    Assert.Equal(FrameKind.Face, r.Frame.Kind);
                    face++;
                    var f = StageFrames.ToFace(r.Frame);
                    Assert.NotEmpty(f.Weights);
                    Assert.All(f.Weights, w =>
                    {
                        Assert.Equal(StageProtocol.ArkitCount, w.Length);
                        Assert.All(w, x => Assert.InRange(x, 0f, 1f));
                    });
                }
            }
            Assert.True(audio >= 2 && face >= 1, audio + " audio and " + face + " face frames recorded");
        }

        [Fact]
        public void EncodeThenDecode_RoundTripsAudio()
        {
            var pcm = Enumerable.Range(0, 480).SelectMany(i => BitConverter.GetBytes((short)(i * 50 - 12000))).ToArray();
            var data = StageFrames.Encode(FrameKind.Audio, StageFrames.Fnv1a32("utt-1"), 123.5, pcm);
            var r = StageFrames.Decode(data);
            Assert.True(r.Ok, r.Error);
            Assert.Equal(StageFrames.Fnv1a32("utt-1"), r.Frame.UtteranceIdHash);
            Assert.Equal(123.5, r.Frame.TStartMs);
            Assert.Equal(pcm, r.Frame.Payload);
            Assert.Equal(20.0, StageFrames.ToAudio(r.Frame).DurationMs, 6);
        }

        [Fact]
        public void EncodeThenDecode_RoundTripsFaceWeightsAndTheirTimes()
        {
            var weights = new float[3][];
            for (var i = 0; i < 3; i++) weights[i] = Enumerable.Range(0, 52).Select(j => (i * 52 + j) / 156f).ToArray();
            var payload = weights.SelectMany(w => w).SelectMany(BitConverter.GetBytes).ToArray();
            var r = StageFrames.Decode(StageFrames.Encode(FrameKind.Face, 7, 1000, payload));
            Assert.True(r.Ok, r.Error);
            var face = StageFrames.ToFace(r.Frame);
            Assert.Equal(3, face.Weights.Length);
            for (var i = 0; i < 3; i++) Assert.Equal(weights[i], face.Weights[i]);
            Assert.Equal(1000 + 2 * 1000.0 / 30.0, face.TimeOfFrameMs(2), 6);
        }

        [Fact]
        public void TheHeaderIsLittleEndianByteForByte()
        {
            var data = StageFrames.Encode(FrameKind.Audio, 0x01020304, 1.0, new byte[] { 9, 9 });
            Assert.Equal(new byte[] { 1, 0x04, 0x03, 0x02, 0x01 }, data.Take(5).ToArray());
            Assert.Equal(BitConverter.GetBytes(1.0), data.Skip(5).Take(8).ToArray());
            Assert.Equal(new byte[] { 9, 9 }, data.Skip(13).ToArray());
        }

        [Theory]
        [InlineData("truncated")]
        [InlineData("unknown_kind")]
        [InlineData("bad_time")]
        [InlineData("empty_payload")]
        [InlineData("misaligned_audio")]
        [InlineData("misaligned_face")]
        [InlineData("weight_range")]
        [InlineData("non_finite")]
        [InlineData("audio_too_large")]
        [InlineData("oversized")]
        public void MalformedFramesAreRefusedWithAReasonAndNeverThrow(string kind)
        {
            byte[] data;
            string expected;
            switch (kind)
            {
                case "truncated": data = new byte[12]; expected = "truncated"; break;
                case "unknown_kind": data = Raw(9, 1.0, new byte[] { 1, 0 }); expected = "unknown_kind"; break;
                case "bad_time": data = Raw(1, -5.0, new byte[] { 1, 0 }); expected = "bad_time"; break;
                case "empty_payload": data = Raw(1, 1.0, new byte[0]); expected = "empty_payload"; break;
                case "misaligned_audio": data = Raw(1, 1.0, new byte[] { 1, 0, 2 }); expected = "misaligned"; break;
                case "misaligned_face": data = Raw(2, 1.0, new byte[207]); expected = "misaligned"; break;
                case "weight_range": data = Raw(2, 1.0, Face(1.5f)); expected = "weight_range"; break;
                case "non_finite": data = Raw(2, 1.0, Face(float.NaN)); expected = "non_finite"; break;
                case "audio_too_large": data = Raw(1, 1.0, new byte[StageProtocol.MaxAudioPayloadBytes + 2]); expected = "payload_too_large"; break;
                default: data = new byte[StageProtocol.MaxFrameBytes + 1]; expected = "oversized"; break;
            }
            var r = StageFrames.Decode(data);
            Assert.False(r.Ok);
            Assert.Equal(expected, r.Error);
            Assert.False(StageFrames.Decode(null).Ok);
        }

        private static byte[] Raw(byte kind, double t, byte[] payload)
        {
            var data = new byte[StageProtocol.FrameHeaderBytes + payload.Length];
            data[0] = kind;
            Buffer.BlockCopy(BitConverter.GetBytes(t), 0, data, 5, 8);
            Buffer.BlockCopy(payload, 0, data, StageProtocol.FrameHeaderBytes, payload.Length);
            return data;
        }

        private static byte[] Face(float first)
        {
            var w = new float[52];
            w[0] = first;
            return w.SelectMany(BitConverter.GetBytes).ToArray();
        }
    }

    public class CredentialsTests
    {
        private static readonly string Token = new string('a', 43);
        private static Func<string, string> Env(params (string, string)[] pairs) => k => pairs.Where(p => p.Item1 == k).Select(p => p.Item2).FirstOrDefault();

        [Fact]
        public void TheEnvironmentWins_AndTheSourceNamesTheVariableNeverTheToken()
        {
            var c = StageCredentialsResolver.Resolve(Env((StageCredentialsResolver.TokenVariable, "  " + Token + " "), (StageCredentialsResolver.UrlVariable, "ws://localhost:8000/ws/stage")), _ => throw new Exception("must not read a file"));
            Assert.Equal(Token, c.Token);
            Assert.Equal("MIRA_STAGE_TOKEN", c.TokenSource);
            Assert.Equal("ws://localhost:8000/ws/stage", c.Url.ToString());
        }

        [Theory]
        [InlineData(true, "APPDATA", @"C:\Users\me\AppData\Roaming", "ai-assistant")]
        [InlineData(false, "XDG_DATA_HOME", "/data/xdg", "ai-assistant")]
        [InlineData(false, "HOME", "/home/me", ".local")]
        public void WithoutAVariableItReadsTheDaemonsOwnSecretsFile(bool windows, string variable, string value, string expectedPart)
        {
            string read = null;
            var c = StageCredentialsResolver.Resolve(Env((variable, value)), p => { read = p; return "{\"hookToken\":\"x\",\"stageToken\":\"" + Token + "\"}"; }, windows);
            Assert.Equal(Token, c.Token);
            Assert.Contains(expectedPart, read);
            Assert.EndsWith("secrets.json", read);
            Assert.Equal(read, c.TokenSource);
        }

        [Fact]
        public void MiraDataDirPointsAtAnotherDataDirectory()
        {
            string read = null;
            StageCredentialsResolver.Resolve(Env((StageCredentialsResolver.DataDirVariable, "/somewhere")), p => { read = p; return null; }, false);
            Assert.Equal(System.IO.Path.Combine("/somewhere", "secrets.json"), read);
        }

        [Theory]
        [InlineData(null)]
        [InlineData("not json")]
        [InlineData("{\"stageToken\":\"short\"}")]
        [InlineData("{\"hookToken\":\"only\"}")]
        public void NoUsableTokenMeansNullNotAGuess(string fileContent)
        {
            var c = StageCredentialsResolver.Resolve(Env(("HOME", "/h")), _ => fileContent, false);
            Assert.Null(c.Token);
            Assert.Equal("ws://127.0.0.1:7421/ws/stage", c.Url.ToString());
        }

        [Theory]
        [InlineData("wss://127.0.0.1:7421/ws/stage")]
        [InlineData("http://127.0.0.1:7421/ws/stage")]
        [InlineData("ws://example.com:7421/ws/stage")]
        [InlineData("ws://192.168.1.5:7421/ws/stage")]
        [InlineData("ws://user:pw@127.0.0.1:7421/ws/stage")]
        [InlineData("ws://127.0.0.1:7421/ws/stage?token=abc")]
        [InlineData("garbage")]
        public void OnlyALoopbackWsUrlWithoutCredentialsOrQueryIsAccepted(string url) =>
            Assert.Throws<ArgumentException>(() => StageCredentialsResolver.ParseUrl(url));

        [Theory]
        [InlineData("ws://127.0.0.1:7421/ws/stage")]
        [InlineData("ws://localhost:7421/ws/stage")]
        [InlineData("ws://[::1]:7421/ws/stage")]
        public void LoopbackUrlsAreAccepted(string url) => Assert.NotNull(StageCredentialsResolver.ParseUrl(url));

        [Fact]
        public void TheClientRefusesAQueryStringAndAMissingToken()
        {
            Assert.Throws<ArgumentException>(() => new StageClient(new StageClientOptions { Token = Token, Url = new Uri("ws://127.0.0.1:7421/ws/stage?x=1") }, new HeadlessStageHandler()));
            Assert.Throws<ArgumentException>(() => new StageClient(new StageClientOptions { Token = "" }, new HeadlessStageHandler()));
            Assert.Throws<ArgumentException>(() => new StageClient(new StageClientOptions { Token = Token, Url = new Uri("wss://127.0.0.1:7421/ws/stage") }, new HeadlessStageHandler()));
        }

        [Theory]
        [InlineData("The server returned status code '401' when status code '101' was expected.", 401)]
        [InlineData("The server returned status code '409' when status code '101' was expected.", 409)]
        [InlineData("HTTP 403 Forbidden", 403)]
        [InlineData("Unable to connect to the remote server", 0)]
        [InlineData("The remote party closed the WebSocket connection without completing the close handshake.", 0)]
        public void RefusalStatus_ReadsTheNumberFromWhateverWordingThePlatformUses(string message, int expected) =>
            Assert.Equal(expected, WebSocketStageTransport.RefusalStatus(new System.Net.WebSockets.WebSocketException(message)));
    }
}
