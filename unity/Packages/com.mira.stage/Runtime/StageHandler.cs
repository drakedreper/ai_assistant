// What the engine implements. The client calls the handler for each command, one at a time and in order (the simulator
// stage does the same), and for each binary frame as it arrives. In Unity the handler hands the work to the main thread
// and completes the returned task there. Every callback arrives on a background thread, never on Unity's main thread.
// (The Unity layer that does that is added on the PC under Runtime/Unity; see docs/UNITY.md.)
using System.Threading;
using System.Threading.Tasks;

namespace Mira.Stage
{
    public sealed class CommandResult
    {
        public bool Ok { get; private set; }
        public string Reason { get; private set; }

        public static readonly CommandResult Done = new CommandResult { Ok = true };

        /// <summary>A plain, short reason: it is shown to the user in Settings, Stage.</summary>
        public static CommandResult Fail(string reason) => new CommandResult { Ok = false, Reason = reason };
    }

    /// <summary>What a handler can tell the backend, besides the command acknowledgements the client sends by itself.</summary>
    public interface IStageSink
    {
        /// <summary>Milliseconds on the stage clock agreed in hello (since this client started).</summary>
        double StageNowMs { get; }
        void AssetLoaded(string assetId, double ms);
        void AssetFailed(string assetId, string reason);
        void SpeakStarted(string utteranceId);
        void SpeakEnded(string utteranceId, bool interrupted);
        void Perf(double fps, double gpuMs, double vramMb);
        void UserPresence(bool present, bool? lookingAtScreen = null, string distance = null);
        void ObjectClicked(string objectId, string button = "primary");
        void CharacterInteract(string characterId, string region, string kind);
        void ReportError(string message, bool fatal = false);
    }

    public interface IStageHandler
    {
        /// <summary>The connection is up and hello was sent. Keep the sink to report events later.</summary>
        void OnConnected(IStageSink sink);

        /// <summary>The connection ended. The client reconnects by itself unless it was stopped.</summary>
        void OnDisconnected(string reason);

        /// <summary>Run one command. Return Done, or Fail with a plain reason. Called strictly one at a time, in order.</summary>
        Task<CommandResult> HandleAsync(StageCommand command, CancellationToken ct);

        /// <summary>A chunk of speech audio. Called as frames arrive, even while a command is still running; must not block.</summary>
        void OnAudioFrame(AudioFrame frame);

        /// <summary>Face weights for the speech in progress. Called as frames arrive; must not block.</summary>
        void OnFaceFrames(FaceFrames frames);
    }

    /// <summary>
    /// A handler that dispatches by command type and fails what it does not override, with the same plain reason the
    /// simulator stage uses. Derive from it and override what the engine can do.
    /// </summary>
    public abstract class StageHandlerBase : IStageHandler
    {
        protected IStageSink Sink { get; private set; }

        public virtual void OnConnected(IStageSink sink) { Sink = sink; }
        public virtual void OnDisconnected(string reason) { Sink = null; }
        public virtual void OnAudioFrame(AudioFrame frame) { }
        public virtual void OnFaceFrames(FaceFrames frames) { }

        public Task<CommandResult> HandleAsync(StageCommand command, CancellationToken ct)
        {
            switch (command)
            {
                case CharacterLoad c: return OnCharacterLoad(c, ct);
                case CharacterParams c: return OnCharacterParams(c, ct);
                case CharacterEquip c: return OnCharacterEquip(c, ct);
                case CharacterOutfit c: return OnCharacterOutfit(c, ct);
                case SceneLoad c: return OnSceneLoad(c, ct);
                case SceneCamera c: return OnSceneCamera(c, ct);
                case SceneLighting c: return OnSceneLighting(c, ct);
                case PerformSpeak c: return OnSpeak(c, ct);
                case PerformCancel c: return OnCancel(c, ct);
                case PerformAffect c: return OnAffect(c, ct);
                case PerformGesture c: return OnGesture(c, ct);
                case PerformGaze c: return OnGaze(c, ct);
                case PerformPosture c: return OnPosture(c, ct);
                case PerformIdle c: return OnIdle(c, ct);
                default: return Unsupported(command);
            }
        }

        protected static Task<CommandResult> Unsupported(StageCommand c) =>
            Task.FromResult(CommandResult.Fail("this stage does not support " + c.Type));

        protected virtual Task<CommandResult> OnCharacterLoad(CharacterLoad c, CancellationToken ct) => Unsupported(c);
        protected virtual Task<CommandResult> OnCharacterParams(CharacterParams c, CancellationToken ct) => Unsupported(c);
        protected virtual Task<CommandResult> OnCharacterEquip(CharacterEquip c, CancellationToken ct) => Unsupported(c);
        protected virtual Task<CommandResult> OnCharacterOutfit(CharacterOutfit c, CancellationToken ct) => Unsupported(c);
        protected virtual Task<CommandResult> OnSceneLoad(SceneLoad c, CancellationToken ct) => Unsupported(c);
        protected virtual Task<CommandResult> OnSceneCamera(SceneCamera c, CancellationToken ct) => Unsupported(c);
        protected virtual Task<CommandResult> OnSceneLighting(SceneLighting c, CancellationToken ct) => Unsupported(c);
        protected virtual Task<CommandResult> OnSpeak(PerformSpeak c, CancellationToken ct) => Unsupported(c);
        protected virtual Task<CommandResult> OnCancel(PerformCancel c, CancellationToken ct) => Unsupported(c);
        protected virtual Task<CommandResult> OnAffect(PerformAffect c, CancellationToken ct) => Unsupported(c);
        protected virtual Task<CommandResult> OnGesture(PerformGesture c, CancellationToken ct) => Unsupported(c);
        protected virtual Task<CommandResult> OnGaze(PerformGaze c, CancellationToken ct) => Unsupported(c);
        protected virtual Task<CommandResult> OnPosture(PerformPosture c, CancellationToken ct) => Unsupported(c);
        protected virtual Task<CommandResult> OnIdle(PerformIdle c, CancellationToken ct) => Unsupported(c);
    }
}
