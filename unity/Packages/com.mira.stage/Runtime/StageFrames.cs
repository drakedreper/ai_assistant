// Binary frames of mira-stage/1, exactly as packages/stage-core/src/protocol/frames.ts defines them (the reference codec):
//
//   [kind:u8][utteranceIdHash:u32][tStartMs:f64][payload...]      little-endian, header = 13 bytes
//
//   kind 1 audio  pcm_s16le mono, 24 kHz, about 20 ms per frame
//   kind 2 face   ARKit weights, one f32 per entry of StageProtocol.Arkit52 = 208 bytes per 30 fps frame; a message carries
//                 k >= 1 consecutive frames, the i-th at tStartMs + i * 1000/30
//   kind 3 body   reserved
//
// The decoder never throws: every malformed input yields Ok = false with a reason, like the reference decoder.
using System;
using System.Text;

namespace Mira.Stage
{
    public enum FrameKind : byte
    {
        Audio = 1,
        Face = 2,
        Body = 3,
    }

    public sealed class StageFrame
    {
        public FrameKind Kind { get; set; }
        public uint UtteranceIdHash { get; set; }
        public double TStartMs { get; set; }
        public byte[] Payload { get; set; }
    }

    public sealed class FrameDecodeResult
    {
        public bool Ok { get; set; }
        public string Error { get; set; }
        public StageFrame Frame { get; set; }
    }

    /// <summary>A chunk of PCM (16-bit little-endian, mono) to schedule on the stage clock.</summary>
    public sealed class AudioFrame
    {
        public uint UtteranceIdHash { get; set; }
        public double TStartMs { get; set; }
        public byte[] Pcm { get; set; }
        public int SampleRate { get; set; } = StageProtocol.AudioSampleRate;
        public double DurationMs => Pcm.Length / 2.0 / SampleRate * 1000.0;
    }

    /// <summary>k consecutive face frames of 52 ARKit weights each (0..1), the i-th at TStartMs + i * 1000/30.</summary>
    public sealed class FaceFrames
    {
        public uint UtteranceIdHash { get; set; }
        public double TStartMs { get; set; }
        public float[][] Weights { get; set; }
        public double TimeOfFrameMs(int index) => TStartMs + index * 1000.0 / StageProtocol.FaceFps;
    }

    public static class StageFrames
    {
        /// <summary>The utterance id hash of the header: FNV-1a 32 over the UTF-8 bytes of the id (a lone surrogate becomes U+FFFD).</summary>
        public static uint Fnv1a32(string text)
        {
            unchecked
            {
                uint h = 0x811c9dc5;
                foreach (var b in Encoding.UTF8.GetBytes(text ?? string.Empty))
                {
                    h ^= b;
                    h *= 0x01000193;
                }
                return h;
            }
        }

        public static FrameDecodeResult Decode(byte[] data)
        {
            if (data == null) return Fail("not_binary");
            if (data.Length > StageProtocol.MaxFrameBytes) return Fail("oversized");
            if (data.Length < StageProtocol.FrameHeaderBytes) return Fail("truncated");
            var kind = data[0];
            if (kind < 1 || kind > 3) return Fail("unknown_kind");
            var hash = ReadUInt32(data, 1);
            var t = ReadDouble(data, 5);
            if (double.IsNaN(t) || double.IsInfinity(t) || t < 0 || t > 9007199254740991.0) return Fail("bad_time");
            var payloadLength = data.Length - StageProtocol.FrameHeaderBytes;
            if (payloadLength == 0) return Fail("empty_payload");
            if (kind == (byte)FrameKind.Audio)
            {
                if (payloadLength > StageProtocol.MaxAudioPayloadBytes) return Fail("payload_too_large");
                if (payloadLength % 2 != 0) return Fail("misaligned");
            }
            else if (kind == (byte)FrameKind.Face)
            {
                if (payloadLength % StageProtocol.FaceFrameBytes != 0) return Fail("misaligned");
                if (payloadLength / StageProtocol.FaceFrameBytes > StageProtocol.MaxFaceFramesPerMessage) return Fail("payload_too_large");
                for (var o = StageProtocol.FrameHeaderBytes; o < data.Length; o += 4)
                {
                    var w = ReadSingle(data, o);
                    if (float.IsNaN(w) || float.IsInfinity(w)) return Fail("non_finite");
                    if (w < 0f || w > 1f) return Fail("weight_range");
                }
            }
            var payload = new byte[payloadLength];
            Buffer.BlockCopy(data, StageProtocol.FrameHeaderBytes, payload, 0, payloadLength);
            return new FrameDecodeResult { Ok = true, Frame = new StageFrame { Kind = (FrameKind)kind, UtteranceIdHash = hash, TStartMs = t, Payload = payload } };
        }

        public static AudioFrame ToAudio(StageFrame frame, int sampleRate = StageProtocol.AudioSampleRate) =>
            new AudioFrame { UtteranceIdHash = frame.UtteranceIdHash, TStartMs = frame.TStartMs, Pcm = frame.Payload, SampleRate = sampleRate };

        public static FaceFrames ToFace(StageFrame frame)
        {
            var count = frame.Payload.Length / StageProtocol.FaceFrameBytes;
            var weights = new float[count][];
            for (var i = 0; i < count; i++)
            {
                var w = new float[StageProtocol.ArkitCount];
                for (var j = 0; j < StageProtocol.ArkitCount; j++) w[j] = ReadSingle(frame.Payload, i * StageProtocol.FaceFrameBytes + j * 4);
                weights[i] = w;
            }
            return new FaceFrames { UtteranceIdHash = frame.UtteranceIdHash, TStartMs = frame.TStartMs, Weights = weights };
        }

        /// <summary>Builds a frame (tests, and a stage that sends frames itself). Throws on a programmer mistake, like the reference encoder.</summary>
        public static byte[] Encode(FrameKind kind, uint utteranceIdHash, double tStartMs, byte[] payload)
        {
            if (payload == null || payload.Length == 0) throw new ArgumentException("empty payload");
            if (double.IsNaN(tStartMs) || double.IsInfinity(tStartMs) || tStartMs < 0 || tStartMs > 9007199254740991.0) throw new ArgumentException("tStartMs out of range");
            var data = new byte[StageProtocol.FrameHeaderBytes + payload.Length];
            data[0] = (byte)kind;
            WriteBytes(data, 1, BitConverter.GetBytes(utteranceIdHash));
            WriteBytes(data, 5, BitConverter.GetBytes(tStartMs));
            Buffer.BlockCopy(payload, 0, data, StageProtocol.FrameHeaderBytes, payload.Length);
            return data;
        }

        private static FrameDecodeResult Fail(string error) => new FrameDecodeResult { Ok = false, Error = error };

        // Little-endian reads that do not depend on the machine's byte order.
        private static uint ReadUInt32(byte[] b, int o) => (uint)(b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24));

        private static double ReadDouble(byte[] b, int o)
        {
            var bits = (ulong)ReadUInt32(b, o) | ((ulong)ReadUInt32(b, o + 4) << 32);
            return BitConverter.Int64BitsToDouble((long)bits);
        }

        private static float ReadSingle(byte[] b, int o) => BitConverter.ToSingle(BitConverter.GetBytes(ReadUInt32(b, o)), 0);

        private static void WriteBytes(byte[] target, int offset, byte[] value)
        {
            if (!BitConverter.IsLittleEndian) Array.Reverse(value);
            Buffer.BlockCopy(value, 0, target, offset, value.Length);
        }
    }
}
