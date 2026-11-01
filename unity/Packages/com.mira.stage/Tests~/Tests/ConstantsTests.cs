using System.Linq;
using Newtonsoft.Json.Linq;
using Xunit;

namespace Mira.Stage.Tests
{
    /// <summary>
    /// The numbers and tables the C# client hard-codes, against golden/constants.json, which apps/daemon/test/stage.golden.test.ts
    /// proves equal to the TypeScript exports. If the order of the 52 ARKit names ever drifted, every face frame would move
    /// the wrong part of the face, with no error anywhere.
    /// </summary>
    public class ConstantsTests
    {
        private static JObject Golden() => JObject.Parse(TestPaths.ReadGolden("constants.json"));

        [Fact]
        public void TheProtocolConstantsEqualTheTypeScriptOnes()
        {
            var g = Golden();
            // (the TypeScript value is in the file, the C# constant is what is being checked: it comes first only for xunit's analyzer)
            Assert.Equal(StageProtocol.Version, g.Value<string>("protocol"));
            Assert.Equal(StageProtocol.FrameHeaderBytes, g.Value<int>("frameHeaderBytes"));
            Assert.Equal(StageProtocol.ArkitCount, g.Value<int>("arkitCount"));
            Assert.Equal(StageProtocol.FaceFrameBytes, g.Value<int>("faceFrameBytes"));
            Assert.Equal(StageProtocol.FaceFps, g.Value<double>("faceFps"));
            Assert.Equal(StageProtocol.AudioSampleRate, g.Value<int>("audioSampleRate"));
            Assert.Equal(StageProtocol.MaxFrameBytes, g.Value<int>("maxFrameBytes"));
            Assert.Equal(StageProtocol.MaxAudioPayloadBytes, g.Value<int>("maxAudioPayloadBytes"));
            Assert.Equal(StageProtocol.MaxFaceFramesPerMessage, g.Value<int>("maxFaceFramesPerMessage"));
        }

        [Fact]
        public void TheArkitNamesAreInTheCanonicalOrderOfAFaceFrame()
        {
            var expected = Golden()["arkit52"].Values<string>().ToArray();
            Assert.Equal(52, expected.Length);
            Assert.Equal(expected, StageProtocol.Arkit52);
        }

        [Fact]
        public void TheWardrobeSlotsAreTheContractsInTheContractsOrder()
        {
            Assert.Equal(Golden()["wardrobeSlots"].Values<string>().ToArray(), StageProtocol.WardrobeSlots);
        }
    }
}
