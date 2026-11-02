# Changelog

## [1.4.0](https://github.com/ANT1OFF/gram/compare/v1.3.1...v1.4.0) (2026-11-02)


### Features

* **agents:** identify Gram's Claude processes as the gram entrypoint ([#91](https://github.com/ANT1OFF/gram/issues/91)) ([f7dd703](https://github.com/ANT1OFF/gram/commit/f7dd703eee5da11dea17ecdf07617ddb4ebbe12f))
* **desktop:** run on Linux ([#82](https://github.com/ANT1OFF/gram/issues/82)) ([1d37deb](https://github.com/ANT1OFF/gram/commit/1d37debd4ba6dbcd61f9f2ba9e573a891ed877ac))
* **desktop:** turn voice input off on Linux with one check ([#79](https://github.com/ANT1OFF/gram/issues/79)) ([470ff8b](https://github.com/ANT1OFF/gram/commit/470ff8b2a0cfe1b5084d0abae659c42794701bc2))
* **orchestration:** a person's PR comment wakes the worker that owns it ([#86](https://github.com/ANT1OFF/gram/issues/86)) ([19bdc1c](https://github.com/ANT1OFF/gram/commit/19bdc1c0dd3366885d2c6f81b33d5b7f5601467c))
* **orchestration:** a wrap-up turn when a worker stops without reporting ([#88](https://github.com/ANT1OFF/gram/issues/88)) ([36a07fb](https://github.com/ANT1OFF/gram/commit/36a07fbb6e69dfc1f3dcaa8da4eefb947a4f75e9))
* **orchestration:** workers say what they ruled out and check before repeating ([#90](https://github.com/ANT1OFF/gram/issues/90)) ([8bdce01](https://github.com/ANT1OFF/gram/commit/8bdce0156500e5cf1080cf4b2e05d11a7db70654))
* **release:** publish and update Linux AppImage and .deb ([#95](https://github.com/ANT1OFF/gram/issues/95)) ([c33c464](https://github.com/ANT1OFF/gram/commit/c33c46458905e469ccbf64a704a90b4c3a4b3fc3))
* **voice:** an accurate mode with a Parakeet pass on each pause ([#83](https://github.com/ANT1OFF/gram/issues/83)) ([2b04a52](https://github.com/ANT1OFF/gram/commit/2b04a529333a039ffb8f3ce9fb2f71bc5d3271cb))
* **voice:** hold one key to talk, with a tone at each end ([#87](https://github.com/ANT1OFF/gram/issues/87)) ([1a9b3ef](https://github.com/ANT1OFF/gram/commit/1a9b3ef168f232e5aea2293de5302a6463d5554e))
* **voice:** start capture at the press, and an opt-in ready microphone ([#81](https://github.com/ANT1OFF/gram/issues/81)) ([505d240](https://github.com/ANT1OFF/gram/commit/505d240a6c6e4d7d79520248b0818acd9264d342))
* **web:** a Done section that keeps the last 7 days ([#65](https://github.com/ANT1OFF/gram/issues/65)) ([8c7bd49](https://github.com/ANT1OFF/gram/commit/8c7bd491870f93ae961fd7d3cc6e1412940ca351))
* **web:** Done lists every finished chat ([#67](https://github.com/ANT1OFF/gram/issues/67)) ([c91d9ac](https://github.com/ANT1OFF/gram/commit/c91d9ac51a3f7bfafba756faa2fa40059e1cab03))
* **web:** one attention count, quieter rows, a sidebar and board that agree ([#92](https://github.com/ANT1OFF/gram/issues/92)) ([f193da4](https://github.com/ANT1OFF/gram/commit/f193da4a57fcbd01accbd76fd695da3bb7dbb5f3))
* **web:** orchestrator → workers in the sidebar, a board that matches ([#80](https://github.com/ANT1OFF/gram/issues/80)) ([686e737](https://github.com/ANT1OFF/gram/commit/686e7372d43ae639fa066c7be2afa16ccca28713))


### Bug Fixes

* **desktop:** harden the Linux key vault and autostart entry ([#85](https://github.com/ANT1OFF/gram/issues/85)) ([4b35eac](https://github.com/ANT1OFF/gram/commit/4b35eac88ff85820c535415031668488e9f533c6))
* **e2e:** hold the t-flaky turn while the smoke test reads its opening line ([#93](https://github.com/ANT1OFF/gram/issues/93)) ([2edc4ac](https://github.com/ANT1OFF/gram/commit/2edc4ac289ef17b396f68ef25d44751d21affc1a))
* **e2e:** release the dictation tap as soon as a word is heard ([#94](https://github.com/ANT1OFF/gram/issues/94)) ([7781194](https://github.com/ANT1OFF/gram/commit/778119452d8e8a39c73e5a1c82c8c865d0bdaf6b))
* prepare only approved local-check sources ([#32](https://github.com/ANT1OFF/gram/issues/32)) ([af3fab7](https://github.com/ANT1OFF/gram/commit/af3fab78c17a9d7a42feb6b4fd733d7645f95fc2))
* repair main after [#32](https://github.com/ANT1OFF/gram/issues/32) ([#68](https://github.com/ANT1OFF/gram/issues/68)) ([ce352e6](https://github.com/ANT1OFF/gram/commit/ce352e608d7949828db4af6a4b3d125fd35d4cb2))
* **voice:** keep the last word after release ([#78](https://github.com/ANT1OFF/gram/issues/78)) ([cc40a47](https://github.com/ANT1OFF/gram/commit/cc40a471c32e814e4ef92caa23d37cb8c667140f))

## [1.3.1](https://github.com/ANT1OFF/gram/compare/v1.3.0...v1.3.1) (2026-11-01)


### Bug Fixes

* **codex:** move to 0.166.0 and omit unset reasoning effort ([#64](https://github.com/ANT1OFF/gram/issues/64)) ([2d805fe](https://github.com/ANT1OFF/gram/commit/2d805fecd77360a0ea46e145f1a6b0f477b77b97))
* **deps:** write minimumReleaseAge as seconds for Dependabot's Bun ([#62](https://github.com/ANT1OFF/gram/issues/62)) ([3f2d2ea](https://github.com/ANT1OFF/gram/commit/3f2d2ea1d9d7016e83ac4a3494e5c890abdfd02b))

## [1.3.0](https://github.com/ANT1OFF/gram/compare/v1.2.2...v1.3.0) (2026-10-31)


### Features

* **web:** a Done line for finished threads and a right-click menu on workspaces ([#37](https://github.com/ANT1OFF/gram/issues/37)) ([0469daf](https://github.com/ANT1OFF/gram/commit/0469daf85e0fcc8d4a34dde333e8f7396230eb48))
* **web:** a narrower, calmer sidebar ([#49](https://github.com/ANT1OFF/gram/issues/49)) ([364e084](https://github.com/ANT1OFF/gram/commit/364e084509410ef048bf17b191dc65d2f9d30b0e))
* **web:** fold finished turns to one row ([#52](https://github.com/ANT1OFF/gram/issues/52)) ([30e2e36](https://github.com/ANT1OFF/gram/commit/30e2e365e1305be8d85895b37094ff9849de4882))
* **web:** one owner per status in the thread pane ([#46](https://github.com/ANT1OFF/gram/issues/46)) ([18edeb0](https://github.com/ANT1OFF/gram/commit/18edeb0efc0ea35549bcaccf6d2866669c7b470a))
* **web:** one send button that takes what the composer can do ([#54](https://github.com/ANT1OFF/gram/issues/54)) ([800bfa4](https://github.com/ANT1OFF/gram/commit/800bfa4adfe4c051ae98b6c50d9932498683391e))
* **web:** quiet the board, feature cards, start page and new thread ([#40](https://github.com/ANT1OFF/gram/issues/40)) ([b92b682](https://github.com/ANT1OFF/gram/commit/b92b6822e2805bfa78918c80446df1cbc1cc58b3))
* **web:** quieter transcript and plan strip ([#39](https://github.com/ANT1OFF/gram/issues/39)) ([e7f4921](https://github.com/ANT1OFF/gram/commit/e7f4921e4150f0de6464e8865aad164f0907f402))
* **web:** show a setting's help on its label, not a ? beside it ([#41](https://github.com/ANT1OFF/gram/issues/41)) ([61c082f](https://github.com/ANT1OFF/gram/commit/61c082f7b6b66697c24ea2b7703b98479d341160))


### Bug Fixes

* close cancelled launches and retain undelivered Codex approvals ([#38](https://github.com/ANT1OFF/gram/issues/38)) ([450b270](https://github.com/ANT1OFF/gram/commit/450b27069bd0210fe0d86887029a3bca6b130efe))
* keep the fake agent out of shipped apps, and drop Grok ([#48](https://github.com/ANT1OFF/gram/issues/48)) ([0d72b19](https://github.com/ANT1OFF/gram/commit/0d72b19295a70b184a19059e642fadb45e1950e0))
* merge_when_ready goes by the base branch's tip, not the PR's recorded base ([#47](https://github.com/ANT1OFF/gram/issues/47)) ([e1d8fc7](https://github.com/ANT1OFF/gram/commit/e1d8fc7eba5a999da4285cf85f8095fecf55067c))
* preserve branch identity during cleanup and worktree placement ([#35](https://github.com/ANT1OFF/gram/issues/35)) ([a0277c7](https://github.com/ANT1OFF/gram/commit/a0277c7a99c137479265c757783d3bcfcda237d4))
* protect stacked branches and skip prunable worktrees ([#44](https://github.com/ANT1OFF/gram/issues/44)) ([59a95ad](https://github.com/ANT1OFF/gram/commit/59a95adf5f9ff21936eb4f2783f4268e948d1307))
* settle the two flaky tests holding main CI ([#59](https://github.com/ANT1OFF/gram/issues/59)) ([86def63](https://github.com/ANT1OFF/gram/commit/86def63ec0a23ba3d3359194b8f3d892006ff032))
* **web:** catch up after the event feed or a terminal reconnects ([#36](https://github.com/ANT1OFF/gram/issues/36)) ([f159fb9](https://github.com/ANT1OFF/gram/commit/f159fb90f0e7679ad9a5030ac0b243e00344096c))
* **web:** Light first paint, IME composition, held approvals and smaller defects ([#45](https://github.com/ANT1OFF/gram/issues/45)) ([cb44d7e](https://github.com/ANT1OFF/gram/commit/cb44d7e84a604e6a80399e5bd4be7d6cc8e18fcb))
* **web:** mark the selected segment on a card as well as the page ([#33](https://github.com/ANT1OFF/gram/issues/33)) ([d039784](https://github.com/ANT1OFF/gram/commit/d039784cf854421910fefba1b6a5373ea7392abf))
* **web:** one needs-you count, and Quiet shows solo threads' asks ([#42](https://github.com/ANT1OFF/gram/issues/42)) ([4f1c46d](https://github.com/ANT1OFF/gram/commit/4f1c46d289b28fae9880eb635399e182c4b570f5))

## [1.2.2](https://github.com/ANT1OFF/gram/compare/v1.2.1...v1.2.2) (2026-10-27)


### Bug Fixes

* **ci:** classify from the event's merge commit ([#30](https://github.com/ANT1OFF/gram/issues/30)) ([31b643a](https://github.com/ANT1OFF/gram/commit/31b643a40b9fe9ca969c2845a03a0d9c2ddb2c44))
* **test:** make CI warnings mean something ([#28](https://github.com/ANT1OFF/gram/issues/28)) ([dd3a0a2](https://github.com/ANT1OFF/gram/commit/dd3a0a2d5614fbfbe69a31c77eb66d616a7bdfa3))
* **web:** show a merged PR once, its row carrying the worktree cleanup ([#31](https://github.com/ANT1OFF/gram/issues/31)) ([68561d4](https://github.com/ANT1OFF/gram/commit/68561d423978aaefc60b5f6b7eabe3ea8b02d47a))


### Performance Improvements

* **ci:** run only what a change can affect ([#25](https://github.com/ANT1OFF/gram/issues/25)) ([9a89cea](https://github.com/ANT1OFF/gram/commit/9a89ceae36ed0d15442b85f0d3f7e9e3abf543f5))

## [1.2.1](https://github.com/ANT1OFF/gram/compare/v1.2.0...v1.2.1) (2026-10-26)


### Bug Fixes

* **deps:** keep bun.lock free of the release-please annotation so Dependabot can read it ([#22](https://github.com/ANT1OFF/gram/issues/22)) ([145c2b7](https://github.com/ANT1OFF/gram/commit/145c2b738832de0d6950d6e07f2ba6bbaceb1533))
* keep a worker's failing checks out of Needs you ([#23](https://github.com/ANT1OFF/gram/issues/23)) ([f9c51b1](https://github.com/ANT1OFF/gram/commit/f9c51b1f79b1b978b9338e89878bb69b83710cb3))
* remove polynomial regexes and incomplete sanitization flagged by CodeQL ([#15](https://github.com/ANT1OFF/gram/issues/15)) ([9bd5b1c](https://github.com/ANT1OFF/gram/commit/9bd5b1ca2879549b3488974a48cb93b8f04d20fc))
* **test:** give the limit-wait tests fixed thread ids so no resume jitter is 0 ([#24](https://github.com/ANT1OFF/gram/issues/24)) ([001d088](https://github.com/ANT1OFF/gram/commit/001d088bdf6c1958f39a3faccb42d291e689ed62))


### Performance Improvements

* **ci:** shard Vitest and e2e across more runners, package macOS in parallel ([#20](https://github.com/ANT1OFF/gram/issues/20)) ([c70f601](https://github.com/ANT1OFF/gram/commit/c70f601a3bb150bbe3e19fa46c1cd5b62fda922d))

## [1.2.0](https://github.com/ANT1OFF/gram/compare/v1.1.0...v1.2.0) (2026-10-26)


### Features

* a New menu at the overview's + for tasks, workers, one-off threads and workspaces ([#10](https://github.com/ANT1OFF/gram/issues/10)) ([d651faa](https://github.com/ANT1OFF/gram/commit/d651faaefebaa4e781d9c2d69050ae9a05992039))


### Bug Fixes

* keep a tall approval card's buttons above the composer ([#6](https://github.com/ANT1OFF/gram/issues/6)) ([50c26eb](https://github.com/ANT1OFF/gram/commit/50c26eb56b8ce711f781ada2bd8e6364c6b2e518))
* keep the sidebar header clear of macOS's window buttons at any zoom and in full screen ([#8](https://github.com/ANT1OFF/gram/issues/8)) ([dc3d62e](https://github.com/ANT1OFF/gram/commit/dc3d62e2cbcdec1c8bb157738edf1a16f4a5e45a))
* keep the update check from downloading Electron and the codex fixture from losing its release ([#9](https://github.com/ANT1OFF/gram/issues/9)) ([7c931f4](https://github.com/ANT1OFF/gram/commit/7c931f46f2a563bb1cf2d74384da14985dd410a9))

## [1.1.0](https://github.com/ANT1OFF/gram/compare/v1.0.0...v1.1.0) (2026-10-26)


### Features

* let agents create and update workspaces with the user's approval ([#4](https://github.com/ANT1OFF/gram/issues/4)) ([3cbb9cb](https://github.com/ANT1OFF/gram/commit/3cbb9cb88cd54eb052f6c6f06c004386c78e9dcf))

## 1.0.0

Gram's first release: a desktop app for developers who run their own installed Claude Code and
Codex CLIs on their own subscriptions.

* **Your own agents.** Gram runs the Claude Code and Codex command-line tools you install, signed
  in with your own subscription. It has no account of its own and sends no telemetry.
* **Workspaces that plan and delegate.** Pick one or more repositories and say what to work on. An
  orchestrator plans the work and starts workers, each on its own branch in a git worktree.
* **Autonomy you choose.** Supervised, Publish or Full decides what agents may do without asking:
  pushing, opening pull requests, merging.
* **Needs you.** Questions, approvals and waits from every workspace collect in one place.
* **The Board.** A workspace's threads and pull requests, with their checks, reviews and merge
  readiness, read through the GitHub CLI.
* **Usage.** Your five-hour and weekly Claude and Codex limits, read from the installed tools.
* **Signed macOS builds** for Apple silicon that update in place from this repository's releases
  when you ask them to.
