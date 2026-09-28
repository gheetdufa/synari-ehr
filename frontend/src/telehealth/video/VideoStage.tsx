import { useEffect, useRef, useState, type ReactNode } from 'react';
import { RoomEvent, Track } from 'livekit-client';
import {
  CarouselLayout,
  GridLayout,
  isTrackReference,
  LayoutContextProvider,
  ParticipantTile,
  useCreateLayoutContext,
  usePinnedTracks,
  useTracks,
  type TrackReferenceOrPlaceholder,
} from '@livekit/components-react';
import { Eye, EyeOff } from 'lucide-react';

export type StageLayout = 'speaker' | 'grid';

function sameTrack(a: TrackReferenceOrPlaceholder | undefined, b: TrackReferenceOrPlaceholder | undefined): boolean {
  return !!a && !!b && a.participant.identity === b.participant.identity && a.source === b.source;
}

function lastSpoke(track: TrackReferenceOrPlaceholder): number {
  return track.participant.lastSpokeAt?.getTime() ?? 0;
}

/**
 * The video area of a call. Speaker view shows whoever matters most (a pinned tile, a shared
 * screen, else the most recent remote speaker) with your own camera as a small corner preview;
 * grid view shows everyone equally.
 */
export function VideoStage({ layout, alone }: { layout: StageLayout; alone: ReactNode }) {
  const layoutContext = useCreateLayoutContext();
  const [selfViewHidden, setSelfViewHidden] = useState(false);
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { updateOnlyOn: [RoomEvent.ActiveSpeakersChanged], onlySubscribed: false },
  );
  const pinned = usePinnedTracks(layoutContext)[0];

  const remoteScreenShare = tracks.find(
    (track) => isTrackReference(track) && track.source === Track.Source.ScreenShare && !track.participant.isLocal,
  );
  const autoPinned = useRef<string | null>(null);
  const pinDispatch = layoutContext.pin.dispatch;
  const screenShareSid = remoteScreenShare && isTrackReference(remoteScreenShare) ? remoteScreenShare.publication.trackSid : null;

  // Focus a screen someone starts sharing, and let go of it when they stop (unless it was re-pinned).
  useEffect(() => {
    if (screenShareSid && remoteScreenShare && autoPinned.current !== screenShareSid) {
      pinDispatch?.({ msg: 'set_pin', trackReference: remoteScreenShare });
      autoPinned.current = screenShareSid;
    } else if (!screenShareSid && autoPinned.current) {
      pinDispatch?.({ msg: 'clear_pin' });
      autoPinned.current = null;
    }
  }, [screenShareSid, remoteScreenShare, pinDispatch]);

  const pinnedStillPresent = pinned && tracks.some((track) => sameTrack(track, pinned)) ? pinned : undefined;
  const localCamera = tracks.find((track) => track.participant.isLocal && track.source === Track.Source.Camera);
  const remoteCameras = tracks
    .filter((track) => !track.participant.isLocal && track.source === Track.Source.Camera)
    .sort((a, b) => lastSpoke(b) - lastSpoke(a));
  const hasOthers = tracks.some((track) => !track.participant.isLocal);

  const speakerView = layout === 'speaker' || !!pinnedStillPresent;
  const main = pinnedStillPresent ?? remoteScreenShare ?? remoteCameras[0] ?? localCamera ?? tracks[0];
  const pip = localCamera && !sameTrack(localCamera, main) ? localCamera : undefined;
  const strip = tracks.filter((track) => !sameTrack(track, main) && !sameTrack(track, pip));

  return (
    <LayoutContextProvider value={layoutContext}>
      <div className="relative flex h-full w-full flex-col gap-2 p-2 sm:p-3">
        {!hasOthers && (
          <div className="pointer-events-none absolute inset-x-0 top-4 z-10 flex justify-center px-4">
            <div className="pointer-events-auto max-w-md rounded-full bg-black/60 px-4 py-2 text-center text-sm text-white shadow-lg backdrop-blur">
              {alone}
            </div>
          </div>
        )}
        {speakerView && main ? (
          <>
            <div className="relative min-h-0 flex-1">
              <ParticipantTile trackRef={main} className="synari-main-tile" />
              {pip &&
                (selfViewHidden ? (
                  <button
                    type="button"
                    onClick={() => setSelfViewHidden(false)}
                    className="absolute bottom-3 right-3 z-10 inline-flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1.5 text-xs font-medium text-white backdrop-blur hover:bg-black/75"
                  >
                    <Eye className="h-3.5 w-3.5" /> Show self view
                  </button>
                ) : (
                  <div className="synari-pip group absolute bottom-3 right-3 z-10 aspect-[3/4] w-24 overflow-hidden rounded-xl shadow-2xl ring-1 ring-white/15 sm:aspect-video sm:w-52">
                    <ParticipantTile trackRef={pip} disableSpeakingIndicator />
                    <button
                      type="button"
                      onClick={() => setSelfViewHidden(true)}
                      aria-label="Hide self view"
                      title="Hide self view"
                      className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white opacity-80 transition-opacity hover:opacity-100 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                    >
                      <EyeOff className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
            </div>
            {strip.length > 0 && (
              <div className="h-24 shrink-0 sm:h-28">
                <CarouselLayout tracks={strip} orientation="horizontal">
                  <ParticipantTile />
                </CarouselLayout>
              </div>
            )}
          </>
        ) : (
          <div className="min-h-0 flex-1">
            <GridLayout tracks={tracks}>
              <ParticipantTile />
            </GridLayout>
          </div>
        )}
      </div>
    </LayoutContextProvider>
  );
}
