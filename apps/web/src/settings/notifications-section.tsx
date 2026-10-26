import { chimeOf, type ChimeSound, type SettingsPatch } from "@gram/contracts";
import { Check, Play } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";

import { errorMessage } from "@/api/errors";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { CHIME_SOUNDS, playChime } from "@/desktop/chime";
import { useMotionLevel } from "@/motion";
import {
  MAX_AGE_OPTIONS,
  maxAgePatch,
  useReviewRequestFilters,
} from "@/reviews/review-request-filters";
import { PLACEMENT_OPTIONS, useBotRepoSuggestions } from "@/reviews/review-requests";
import { useServerSettings } from "@/settings-sync/store";
import { useLayoutStore } from "@/stores/layout";

import { AwayNotificationRows } from "./away-notification-rows";
import { NOTIFICATIONS_DEFAULTS, resetFor } from "./defaults";
import { NotificationStatusSetting } from "./notification-status-row";
import { OPTION_GROUP, OptionGroup, SettingRow, Toggle } from "./fields";
import { ReviewBotReposField } from "./review-bot-repos-field";
import { SettingsGroup } from "./settings-group";
import { useSaveSettings } from "./use-save-settings";

const SOUNDS = Object.keys(CHIME_SOUNDS) as ChimeSound[];
const CHOICES: readonly (ChimeSound | undefined)[] = [undefined, ...SOUNDS];

type NotificationsKey = keyof typeof NOTIFICATIONS_DEFAULTS;
type NotificationsPatch = NonNullable<SettingsPatch["notifications"]>;

/** Settings → Notifications: desktop notifications and the sound that plays with them. */
export function NotificationsSection() {
  const settings = useServerSettings((s) => s.settings);
  const notifications = settings?.notifications;
  const save = useSaveSettings();
  const requests = useReviewRequestFilters();
  const placement = useLayoutStore((s) => s.reviewRequestsPlacement);
  const setPlacement = useLayoutStore((s) => s.setReviewRequestsPlacement);
  const openPrsPlacement = useLayoutStore((s) => s.openPrsPlacement);
  const setOpenPrsPlacement = useLayoutStore((s) => s.setOpenPrsPlacement);
  const motion = useMotionLevel();
  const botRepoSuggestions = useBotRepoSuggestions();
  const [failed, setFailed] = useState<{ key: NotificationsKey; message: string }>();
  const radios = useRef<(HTMLButtonElement | null)[]>([]);

  if (!settings || !notifications) {
    return <p className="text-sm text-muted-foreground">Loading settings…</p>;
  }

  const failWith = (key: NotificationsKey) => (e: unknown) =>
    setFailed({ key, message: errorMessage(e) });
  const apply = (key: NotificationsKey, patch: NotificationsPatch) => {
    setFailed(undefined);
    save({ notifications: patch }).catch(failWith(key));
  };
  const applyToRequests = (key: NotificationsKey, patch: NotificationsPatch) => {
    setFailed(undefined);
    requests.apply(patch).catch(failWith(key));
  };
  const errorOf = (key: NotificationsKey) => (failed?.key === key ? failed.message : undefined);
  const resetOf = (key: NotificationsKey) => {
    const setting = NOTIFICATIONS_DEFAULTS[key];
    const patch = setting.reset.notifications ?? {};
    return resetFor(settings, () =>
      setting.refreshesReviewRequests === true ? applyToRequests(key, patch) : apply(key, patch),
    )(setting);
  };
  const requestsOff = notifications.reviewRequests === false;
  const offReason = requestsOff ? "Turn on Check for review requests first." : undefined;
  const current = chimeOf(notifications);
  const awaitBot = notifications.reviewRequestsAwaitBot === true;
  const maxAge = requests.maxAge;
  const choose = (sound: ChimeSound | undefined) => {
    if (sound === current) return;
    apply("sound", sound === undefined ? { sounds: false } : { sounds: true, chime: sound });
  };

  // One tab stop for the group; arrows move and choose, like native radios.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (CHOICES.indexOf(current) + step + CHOICES.length) % CHOICES.length;
    choose(CHOICES[next]);
    radios.current[next]?.focus();
  };

  const radio = (sound: ChimeSound | undefined, index: number) => {
    const checked = current === sound;
    return (
      <Button
        key={sound ?? "none"}
        ref={(element: HTMLButtonElement | null) => {
          radios.current[index] = element;
        }}
        size="sm"
        role="radio"
        aria-checked={checked}
        tabIndex={checked ? 0 : -1}
        variant={checked ? "secondary" : "ghost"}
        onClick={() => choose(sound)}
      >
        {checked && <Check aria-hidden data-icon="inline-start" />}
        {sound === undefined ? "None" : CHIME_SOUNDS[sound].label}
      </Button>
    );
  };

  return (
    <div className="flex flex-col gap-6" data-testid="notification-settings">
      <SettingsGroup label="Desktop">
        <Toggle
          label="Desktop notifications"
          description="Notify about asks and failures while the window isn't focused."
          checked={notifications.native}
          onReset={resetOf("native")}
          error={errorOf("native")}
          onChange={(native) => apply("native", { native })}
        />
        <NotificationStatusSetting />
        <SettingRow
          label="Sound"
          description="Plays with desktop notifications, softer with reduced Motion."
          keywords={["motion", "chime", "silent"]}
          onReset={resetOf("sound")}
          error={errorOf("sound")}
          detail={
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                <span>Preview</span>
                {SOUNDS.map((sound) => (
                  <Hint
                    key={sound}
                    label={`Preview ${CHIME_SOUNDS[sound].label}`}
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Preview ${CHIME_SOUNDS[sound].label}`}
                        onClick={() => playChime(sound)}
                      />
                    }
                  >
                    <Play />
                  </Hint>
                ))}
              </div>
              {motion === "off" && current !== undefined && (
                <p data-testid="sound-motion-off" className="text-xs text-muted-foreground">
                  Motion is Off, so notifications stay quiet. Preview still plays the sound.
                </p>
              )}
            </div>
          }
        >
          <div
            role="radiogroup"
            aria-label="Notification sound"
            className={OPTION_GROUP}
            onKeyDown={onKeyDown}
          >
            {CHOICES.map(radio)}
          </div>
        </SettingRow>
        <AwayNotificationRows
          settings={settings}
          apply={apply}
          resetOf={resetOf}
          errorOf={errorOf}
        />
      </SettingsGroup>
      <SettingsGroup
        label="Review requests"
        description="Open pull requests on GitHub that ask for your review. Needs a signed-in gh."
      >
        <Toggle
          label="Check for review requests"
          description="Check GitHub every few minutes, list what's found and notify for new ones."
          checked={!requestsOff}
          onReset={resetOf("reviewRequests")}
          error={errorOf("reviewRequests")}
          onChange={(reviewRequests) => applyToRequests("reviewRequests", { reviewRequests })}
        />
        <SettingRow
          label="Show review requests in"
          description="The sidebar, a Reviews tab in the right panel, or nowhere. Hidden still notifies."
          disabledReason={offReason}
        >
          <OptionGroup
            label="Show review requests in"
            options={PLACEMENT_OPTIONS}
            value={placement}
            disabled={requestsOff}
            onChange={setPlacement}
          />
        </SettingRow>
        <Toggle
          label="Direct requests only"
          description="Only pull requests that ask for you by name, not your team."
          learnMore={<p>Drafts and your own pull requests are always left out.</p>}
          checked={notifications.reviewRequestsDirectOnly !== false}
          disabled={requestsOff}
          disabledReason={offReason}
          onReset={resetOf("directOnly")}
          error={errorOf("directOnly")}
          onChange={(reviewRequestsDirectOnly) =>
            applyToRequests("directOnly", { reviewRequestsDirectOnly })
          }
        />
        <Toggle
          label="Hide bot pull requests"
          description="Leave out pull requests opened by an app, such as dependabot."
          checked={notifications.reviewRequestsHideBots !== false}
          disabled={requestsOff}
          disabledReason={offReason}
          onReset={resetOf("hideBots")}
          error={errorOf("hideBots")}
          onChange={(reviewRequestsHideBots) =>
            applyToRequests("hideBots", { reviewRequestsHideBots })
          }
        />
        <SettingRow
          label="Maximum age"
          description="Leave out pull requests nobody has touched for longer than this."
          disabledReason={offReason}
          onReset={resetOf("maxAge")}
          error={errorOf("maxAge")}
        >
          <OptionGroup
            label="Maximum age"
            options={MAX_AGE_OPTIONS}
            value={maxAge}
            disabled={requestsOff}
            onChange={(choice) => applyToRequests("maxAge", maxAgePatch(choice))}
          />
        </SettingRow>
        <Toggle
          label="Wait for checks"
          description="Notify about a new review request once its checks pass."
          learnMore={
            <p>
              A request without checks notifies at once. The pull request is listed all the while.
            </p>
          }
          checked={notifications.reviewRequestsAwaitChecks === true}
          disabled={requestsOff}
          disabledReason={offReason}
          onReset={resetOf("awaitChecks")}
          error={errorOf("awaitChecks")}
          onChange={(reviewRequestsAwaitChecks) =>
            applyToRequests("awaitChecks", { reviewRequestsAwaitChecks })
          }
        />
        <Toggle
          label="Wait for review bot"
          description="In these repositories, also wait for a review bot to pass the latest commit."
          learnMore={
            <p>
              A bot from Settings → Review bots must review the latest commit without requesting
              changes. Other repositories notify at once.
            </p>
          }
          keywords={["repositories", "repos"]}
          checked={awaitBot}
          disabled={requestsOff}
          disabledReason={offReason}
          onReset={resetOf("awaitBot")}
          error={errorOf("awaitBot")}
          onChange={(reviewRequestsAwaitBot) =>
            applyToRequests("awaitBot", { reviewRequestsAwaitBot })
          }
          detail={
            awaitBot &&
            !requestsOff && (
              <ReviewBotReposField
                repos={notifications.reviewBotRepos ?? botRepoSuggestions}
                onChange={(reviewBotRepos) => applyToRequests("awaitBot", { reviewBotRepos })}
              />
            )
          }
        />
      </SettingsGroup>
      <SettingsGroup
        label="Open PRs"
        description="Your own open pull requests, with the thread that owns each. Never notifies."
      >
        <SettingRow
          label="Show open PRs in"
          description="Below review requests in the sidebar, the Reviews tab, or nowhere."
        >
          <OptionGroup
            label="Show open PRs in"
            options={PLACEMENT_OPTIONS}
            value={openPrsPlacement}
            onChange={setOpenPrsPlacement}
          />
        </SettingRow>
      </SettingsGroup>
    </div>
  );
}
