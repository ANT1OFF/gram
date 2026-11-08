# Changelog

## [1.13.0](https://github.com/ANT1OFF/gram/compare/v1.12.0...v1.13.0) (2026-11-08)


### Features

* a machine id on checkouts and workers, and a hosts migration ([#267](https://github.com/ANT1OFF/gram/issues/267)) ([2f17442](https://github.com/ANT1OFF/gram/commit/2f17442fdc6c08c539414fdb4afa3c041841a27e))
* **composer:** icons with their words on hover; Stop as an icon in Send's place ([#280](https://github.com/ANT1OFF/gram/issues/280)) ([88103dd](https://github.com/ANT1OFF/gram/commit/88103dde0cab04dde00b50b43f9fe31f7ff2928f))
* number each session's agent events and confirm each one once handled ([#273](https://github.com/ANT1OFF/gram/issues/273)) ([bfbfca0](https://github.com/ANT1OFF/gram/commit/bfbfca065d05774921618076b11d9af9ff9668a0))
* **server:** phone access switched from settings, with paired-browser list and live revoke ([#276](https://github.com/ANT1OFF/gram/issues/276)) ([6112f08](https://github.com/ANT1OFF/gram/commit/6112f08504aea5a353c707d45d887430d19f307f))
* **web:** group the sidebar by state in three sections with one header style and one-line rows ([#281](https://github.com/ANT1OFF/gram/issues/281)) ([d64000a](https://github.com/ANT1OFF/gram/commit/d64000aee733eec467559533e67f042ffec8a1a7))
* **web:** say Focus and Memory updates where people read Quiet and Dreams ([#277](https://github.com/ANT1OFF/gram/issues/277)) ([5d34671](https://github.com/ANT1OFF/gram/commit/5d346714c8ab95dc6b47c7dace2e313e66dd09b1))
* **web:** Settings → Machines → Phones and browsers ([#278](https://github.com/ANT1OFF/gram/issues/278)) ([fcc65ab](https://github.com/ANT1OFF/gram/commit/fcc65abd88d91a233bc92310e2f768d436992ae2))


### Bug Fixes

* one quiet line for a run of orchestrator updates, flat merged features ([#284](https://github.com/ANT1OFF/gram/issues/284)) ([24b7a5b](https://github.com/ANT1OFF/gram/commit/24b7a5b64094c064b7543aac0fbcd9f182af3f77))
* treat a newer Codex prerelease as newer in the runtime verdict ([#275](https://github.com/ANT1OFF/gram/issues/275)) ([9854e55](https://github.com/ANT1OFF/gram/commit/9854e55f0c1f1594797e1d324bf2e6597679eb2e))
* **web:** one needs-you mark, fewer title-bar glyphs, Copy and … under messages ([#279](https://github.com/ANT1OFF/gram/issues/279)) ([c7c1a6c](https://github.com/ANT1OFF/gram/commit/c7c1a6ceb435079cf2293ba0d3040739639544dc))


### Performance Improvements

* **git:** back off macOS watcher reconcile reads on idle checkouts ([#269](https://github.com/ANT1OFF/gram/issues/269)) ([bfd8d2c](https://github.com/ANT1OFF/gram/commit/bfd8d2c5748cf2acc35281197726be7680b99fda))
* **server:** number checkout changes and stop polling watched panes ([#272](https://github.com/ANT1OFF/gram/issues/272)) ([66fbaef](https://github.com/ANT1OFF/gram/commit/66fbaef2d09a57bcc1f8f824dafc31a8288bb83f))
* **server:** run the server's SQLite connection on a writer thread ([#268](https://github.com/ANT1OFF/gram/issues/268)) ([3ba80cc](https://github.com/ANT1OFF/gram/commit/3ba80ccd58f58b97870d7538712fb3f0666636d2))

## [1.12.0](https://github.com/ANT1OFF/gram/compare/v1.11.1...v1.12.0) (2026-11-08)


### Features

* calm the sidebar: one-line titles, agent marks only when mixed, one way to History ([#257](https://github.com/ANT1OFF/gram/issues/257)) ([a7686ed](https://github.com/ANT1OFF/gram/commit/a7686ed33bf5aadc52e84860ba0ff9e8cef7ba17))
* one choices chip for the composer's model, effort, mode and speed ([#263](https://github.com/ANT1OFF/gram/issues/263)) ([528328c](https://github.com/ANT1OFF/gram/commit/528328c4416e600227ae6e4666dc85fb616a2efe))
* one worker list, the Workers tab, with status lines and ⌘J ([#252](https://github.com/ANT1OFF/gram/issues/252)) ([8724312](https://github.com/ANT1OFF/gram/commit/8724312372d83492cf58d0513b367ba580c4d47d))
* **sidebar:** monogram rail tiles, an Idle fold, a neutral needs-you pill and one-line working rows ([#259](https://github.com/ANT1OFF/gram/issues/259)) ([b85224e](https://github.com/ANT1OFF/gram/commit/b85224ef6974a8d74c6d1040318e4ba471c58eb7))


### Bug Fixes

* accept newer Codex CLI versions with a warning ([#271](https://github.com/ANT1OFF/gram/issues/271)) ([13eb314](https://github.com/ANT1OFF/gram/commit/13eb314a0061f22f1924468f1d194802c63a1f44))
* one amber, quiet bars and PR chips, and no glyph beside the word it repeats ([#256](https://github.com/ANT1OFF/gram/issues/256)) ([d00249b](https://github.com/ANT1OFF/gram/commit/d00249bf827ec1e88a011ad50a0be4e3d229c9bd))
* one quiet band above the orchestrator's chat and the worker's composer, a still pending ring ([#255](https://github.com/ANT1OFF/gram/issues/255)) ([738733f](https://github.com/ANT1OFF/gram/commit/738733f618e72d77814c38e41554492ff6548df9))
* quiet the orchestrator chat so its reply leads ([#261](https://github.com/ANT1OFF/gram/issues/261)) ([cc00253](https://github.com/ANT1OFF/gram/commit/cc0025359595a93420b36e049b06ba2d764ad8c3))
* read Codex output lines in one pass and keep split characters whole ([#248](https://github.com/ANT1OFF/gram/issues/248)) ([c5d200e](https://github.com/ANT1OFF/gram/commit/c5d200e40adfa12235fa1f1b837b0275d48ad14f))
* **web:** one button language, a View menu for the diff, a full-width Board and a shorter Dreams view ([#260](https://github.com/ANT1OFF/gram/issues/260)) ([4e80999](https://github.com/ANT1OFF/gram/commit/4e80999c074cea440cccdaaf6fa602a01c2c9273))


### Performance Improvements

* keep each checkout's HEAD for the PR lookup while its ref files are unchanged ([#258](https://github.com/ANT1OFF/gram/issues/258)) ([ad4377d](https://github.com/ANT1OFF/gram/commit/ad4377d4b8cd2bad2bc3ca1b701539ec6f673f75))
* keep origin tips and origin/HEAD while their ref files are unchanged ([#251](https://github.com/ANT1OFF/gram/issues/251)) ([64a3964](https://github.com/ANT1OFF/gram/commit/64a39640fcdaaa6a10dcf0f9bc61280807a1a831))
* read only a fork's last messages to resume it, and only prompts for list_checkpoints ([#265](https://github.com/ANT1OFF/gram/issues/265)) ([c2a5881](https://github.com/ANT1OFF/gram/commit/c2a588117f5d19e5de4d64880b37f0d30d7d784b))
* read only a thread's opening for its title, and once it is past its first turn not at all ([#264](https://github.com/ANT1OFF/gram/issues/264)) ([28d8dce](https://github.com/ANT1OFF/gram/commit/28d8dce7864d78d083d09d3287c62bda84ede7c4))
* read only the messages a check needs, not the whole thread ([#247](https://github.com/ANT1OFF/gram/issues/247)) ([17309c6](https://github.com/ANT1OFF/gram/commit/17309c6bd3d1c79983f228735f5b1a7931a644ff))
* remember ahead/behind counts and trial merges by commit ([#249](https://github.com/ANT1OFF/gram/issues/249)) ([a9ee109](https://github.com/ANT1OFF/gram/commit/a9ee1090457ccf62cc762ec2916dc687f3f1e908))
* run search and the usage overview on a read-only SQLite worker ([#250](https://github.com/ANT1OFF/gram/issues/250)) ([07294b1](https://github.com/ANT1OFF/gram/commit/07294b159d1341a2b33e2be7c3ec7ef1b9a7caee))
* **server:** index message part types so part reads skip the history scan ([#266](https://github.com/ANT1OFF/gram/issues/266)) ([6268775](https://github.com/ANT1OFF/gram/commit/6268775dc1f2eeddc20a4571e798633680483760))
* **web:** render only the rail marks whose current state changes on scroll ([#253](https://github.com/ANT1OFF/gram/issues/253)) ([ac2741b](https://github.com/ANT1OFF/gram/commit/ac2741ba2c2aaf435249e9b68feb045eda27631a))

## [1.11.1](https://github.com/ANT1OFF/gram/compare/v1.11.0...v1.11.1) (2026-11-07)


### Bug Fixes

* make the title bar's usage meter an icon-only button and put Memory beside the orchestrator's title ([#243](https://github.com/ANT1OFF/gram/issues/243)) ([1b25478](https://github.com/ANT1OFF/gram/commit/1b25478db40e2407f80b7aea19d07da8eb7c80a9))
* stop a worker's title bar folding and unfolding Take over every few frames ([#246](https://github.com/ANT1OFF/gram/issues/246)) ([94e3f9b](https://github.com/ANT1OFF/gram/commit/94e3f9b228ef9d27509e2a638e1325538a89dd9d))

## [1.11.0](https://github.com/ANT1OFF/gram/compare/v1.10.0...v1.11.0) (2026-11-07)


### Features

* one heavier icon line, glyphs that stand in for words, dots for Done rows and a one-page Docs reader ([#220](https://github.com/ANT1OFF/gram/issues/220)) ([e89366b](https://github.com/ANT1OFF/gram/commit/e89366bcd37f1f2b2b226ea84a85e0339bc9bced))
* palette rows with kind icons and status dots, find in thread across undrawn rows, a filterable shortcut sheet, next/previous thread and ⌘D for the diff ([#219](https://github.com/ANT1OFF/gram/issues/219)) ([9043b7a](https://github.com/ANT1OFF/gram/commit/9043b7abb22306accc50d81701380f7ca7925101))
* recurring routines in the workspace charter, run by a crash-safe engine, and workers that read workspace memory ([#198](https://github.com/ANT1OFF/gram/issues/198)) ([1094fce](https://github.com/ANT1OFF/gram/commit/1094fce6c2fd9dce97296f09c4ee505369974b28))
* Settings → Usage with limit pace, Codex credits and 7/30-day history ([#217](https://github.com/ANT1OFF/gram/issues/217)) ([099c11b](https://github.com/ANT1OFF/gram/commit/099c11b3c8d4983cf4ddacf33b73caf79445ac60))
* snooze a thread, and fold worker takeover help once seen ([#221](https://github.com/ANT1OFF/gram/issues/221)) ([6d0defd](https://github.com/ANT1OFF/gram/commit/6d0defd050c999d6f6f8b0d6bcdba15c1c697d9a))


### Bug Fixes

* keep find busy until the server has answered the typed query ([#226](https://github.com/ANT1OFF/gram/issues/226)) ([98b33f3](https://github.com/ANT1OFF/gram/commit/98b33f3c8483ceecd69da1bee9a14d79db51b886))
* keep the report-issue dialog inside short windows ([#232](https://github.com/ANT1OFF/gram/issues/232)) ([47729cf](https://github.com/ANT1OFF/gram/commit/47729cf7fe0ead18949ce9d3b77a0cd5a7987471))
* keep the right panel's tab names, and select Branch when nothing is uncommitted ([#223](https://github.com/ANT1OFF/gram/issues/223)) ([00201b8](https://github.com/ANT1OFF/gram/commit/00201b869ca69060d03f061e3e36ec9009f71a9a))
* one needs-you count on every surface, and a just-started worker reads Starting ([#229](https://github.com/ANT1OFF/gram/issues/229)) ([91cc573](https://github.com/ANT1OFF/gram/commit/91cc573548ef07e5790770d9b18320f7ac7b2ded))
* persist merge uncertainty fences across restarts ([#202](https://github.com/ANT1OFF/gram/issues/202)) ([fcd9eb1](https://github.com/ANT1OFF/gram/commit/fcd9eb11ec95c46eaf18f5b8b2480a769d424e6b))
* remove timing dependencies from watcher and ownership tests ([#231](https://github.com/ANT1OFF/gram/issues/231)) ([93b3be1](https://github.com/ANT1OFF/gram/commit/93b3be1ba61c28333806fbdfc4bc10a64004183a))
* signal Codex startup readiness over a fixture socket ([#214](https://github.com/ANT1OFF/gram/issues/214)) ([4c3ef4e](https://github.com/ANT1OFF/gram/commit/4c3ef4e15febed6b8d6abaa1603f8e12c7f7c129))
* start New task where you are, label it, and return from Settings to the same place ([#224](https://github.com/ANT1OFF/gram/issues/224)) ([c187f30](https://github.com/ANT1OFF/gram/commit/c187f30adebce2a43bb93dace3c0b72b86a37584))


### Performance Improvements

* a scale fixture for the renderer, and a thread switch that re-renders only the rows it changes ([#222](https://github.com/ANT1OFF/gram/issues/222)) ([454c557](https://github.com/ANT1OFF/gram/commit/454c557c867464219dd5c835019f8801399944ec))
* load what the first screen doesn't show after first paint, and the rest in one file ([#227](https://github.com/ANT1OFF/gram/issues/227)) ([94aac6e](https://github.com/ANT1OFF/gram/commit/94aac6e6ac0cfb65547abd691a6a7cb24bd170da))
* measure large SQLite workloads and rank server stalls ([#215](https://github.com/ANT1OFF/gram/issues/215)) ([3ff73a3](https://github.com/ANT1OFF/gram/commit/3ff73a3509bb9e397764ccc9769c6efacfa59e28))
* seek feed revisions and stream global search ranks ([#218](https://github.com/ANT1OFF/gram/issues/218)) ([da75e19](https://github.com/ANT1OFF/gram/commit/da75e190f12aa6995f7582c0242ccb713aa0d305))

## [1.10.0](https://github.com/ANT1OFF/gram/compare/v1.9.0...v1.10.0) (2026-11-07)


### Features

* a Workers panel tab that groups an orchestrator's workers by status, with search, a filter and a slot for Docs ([#194](https://github.com/ANT1OFF/gram/issues/194)) ([b96799a](https://github.com/ANT1OFF/gram/commit/b96799a2b4f3be6b87e6c4afcf26a1b7d6d65ef6))
* composer pickers say their value, check it and confirm a pick; a clearer Stop ([#171](https://github.com/ANT1OFF/gram/issues/171)) ([721e97b](https://github.com/ANT1OFF/gram/commit/721e97b6a326e03e53815c97d9d7e922052712b9))
* Discover workspace, a survey a new workspace starts with and the user can run again ([#195](https://github.com/ANT1OFF/gram/issues/195)) ([455a2c5](https://github.com/ANT1OFF/gram/commit/455a2c5fb42f9e3a82c2db3f238e66c1420ca344))
* dock the Inbox beside the work, with short list rows ([#179](https://github.com/ANT1OFF/gram/issues/179)) ([084c9cd](https://github.com/ANT1OFF/gram/commit/084c9cd0c442fcc954480de7b1621d7896cde7dd))
* fewer status states without a legend, one alarm per failure, status words before PR chips, short words in the status strip, firmer light selection ([#185](https://github.com/ANT1OFF/gram/issues/185)) ([23858c4](https://github.com/ANT1OFF/gram/commit/23858c480d61d44b934fc6d49c0dcf4317f6f489))
* larger, firmer secondary text, a type scale with distinct steps, icon sizes per context, middle-cut sidebar titles, said defaults, an equal merge summary, weighted settings rows, History status apart from its action, and a centred memory review ([#188](https://github.com/ANT1OFF/gram/issues/188)) ([b9aa18c](https://github.com/ANT1OFF/gram/commit/b9aa18c61f74cf3cf709584d9a417158863f4ffd))
* legible secondary text, firmer light edges and clearer status marks ([#205](https://github.com/ANT1OFF/gram/issues/205)) ([7a2e149](https://github.com/ANT1OFF/gram/commit/7a2e14925a62d08edd88118eb7dc583e3ea3fa50))
* one approval verb set with a scoped receipt, anchored General settings, a View menu on the review bar, speed in words, a compact Dreams page and a wording sweep ([#182](https://github.com/ANT1OFF/gram/issues/182)) ([5f5352f](https://github.com/ANT1OFF/gram/commit/5f5352fb77f464661e41544c0bebfe57bbbf30e2))
* one count for what needs you, one answer receipt, a neutral usage meter, thread context in the Inbox ([#172](https://github.com/ANT1OFF/gram/issues/172)) ([d59d997](https://github.com/ANT1OFF/gram/commit/d59d997dd14896ea951befa0f715506958597150))
* one spacing rhythm and quieter, single-weight icons ([#196](https://github.com/ANT1OFF/gram/issues/196)) ([34cf6f4](https://github.com/ANT1OFF/gram/commit/34cf6f42c0219757aab5e3c88086d9021c503a75))
* one two-line sidebar row, one dot per state with a legend, a folded setup chip, a turn-aware plan strip, light digests and a content-width Board ([#180](https://github.com/ANT1OFF/gram/issues/180)) ([e26c7dd](https://github.com/ANT1OFF/gram/commit/e26c7dd3ee8b1ffb1d2dd953b4a36398e28aaaa5))
* one way into the Inbox and usage, a folding setup banner, destinations first in a shorter palette, and a narrower usage popover ([#184](https://github.com/ANT1OFF/gram/issues/184)) ([96dc9c9](https://github.com/ANT1OFF/gram/commit/96dc9c9194445148ec6aef6b3811a59704b37d87))
* open a worker beside its orchestrator's chat in the right panel's Thread tab to read and steer it, the orchestrator's messages folded to one line, and New where you last looked ([#200](https://github.com/ANT1OFF/gram/issues/200)) ([727e154](https://github.com/ANT1OFF/gram/commit/727e154146a13464ebc124fd87d8a2e1269072a4))
* plain New form with one authority line, one card per retried turn, one PR blocker summary, review keeps the chat's room, old-thread actions, inline first-run steps ([#178](https://github.com/ANT1OFF/gram/issues/178)) ([035cf99](https://github.com/ANT1OFF/gram/commit/035cf99f96dfb4ab04f7fb0a3f6f0ed745c77b55))
* readable settings, Save/Cancel and Undo on typed fields, labelled usage, Dreams run cards, theme previews, a stronger light scrim and one approval verb ([#177](https://github.com/ANT1OFF/gram/issues/177)) ([f7bcdc3](https://github.com/ANT1OFF/gram/commit/f7bcdc3836024bdb13a0da667f7c96dcf40f86a9))
* repeat starts fold to the brief, starting progress, PR blocker first, shortcut search, save hint, first-run search ([#174](https://github.com/ANT1OFF/gram/issues/174)) ([941192b](https://github.com/ANT1OFF/gram/commit/941192b38e9161b797ab9fff89e963ced5ebb5e0))
* review an oversized diff here, a chunk of hunks at a time, or as a summary ([#170](https://github.com/ANT1OFF/gram/issues/170)) ([de202ce](https://github.com/ANT1OFF/gram/commit/de202ceb244a816e52b3e9121722ee59e262f261))
* separate dark surfaces, one amber, tighter headings and a clearer secondary step, two-line sidebar titles, one icon stroke, a named sound preview and dot meanings on hover ([#190](https://github.com/ANT1OFF/gram/issues/190)) ([2e7d758](https://github.com/ANT1OFF/gram/commit/2e7d758593f5710b484b5e0d401a54437a144556))
* Start says what it checks, one where/who/merge summary, a compact Inbox list with a divider, a one-line first run, the old thread's saved outcome and a Board Done band ([#183](https://github.com/ANT1OFF/gram/issues/183)) ([482b697](https://github.com/ANT1OFF/gram/commit/482b6978949e83f10ed1a148731e86111538f68c))
* stronger current row, one elevation step, a readable Board stage bar and one date format ([#175](https://github.com/ANT1OFF/gram/issues/175)) ([3081f44](https://github.com/ANT1OFF/gram/commit/3081f449a2c6efc1bfc068a9a4e2b53a1e677973))
* the approval card under the tool row it decides, Stop steps back while a turn waits on you, a named usage limit with a full Retry, what Take over changes, and a Merge button that says it is blocked ([#191](https://github.com/ANT1OFF/gram/issues/191)) ([51f4b81](https://github.com/ANT1OFF/gram/commit/51f4b81526fb981a93574bc589e150e7badd9b10))
* the narrow composer keeps short values, one toolbar order, Stop in words, title-bar hover labels ([#181](https://github.com/ANT1OFF/gram/issues/181)) ([d309540](https://github.com/ANT1OFF/gram/commit/d3095406ae31d7dd45d07475384a282dab709acd))
* the setup notice once as an icon, whole words in the status strip, the title before secondary header items, Settings as its own place, hints only when pointed at, and composed first-run, outcome, Board and History ([#192](https://github.com/ANT1OFF/gram/issues/192)) ([3ca99e6](https://github.com/ANT1OFF/gram/commit/3ca99e687a89048605849601a7c51dea1434bac0))
* the waiting row links to its approval, one neutral disabled style, an inline Board Done, sentence-case headings, a firmer dark scrim, auto Focus review when cramped, and room for code, the Inbox and Quiet's context ([#186](https://github.com/ANT1OFF/gram/issues/186)) ([d7262fa](https://github.com/ANT1OFF/gram/commit/d7262faae1581467c4beb354e15db329c4477e8c))
* workspace docs: publish_doc, doc cards, a pinned chip and an editable Docs tab ([#197](https://github.com/ANT1OFF/gram/issues/197)) ([277fbb4](https://github.com/ANT1OFF/gram/commit/277fbb4399d6a8b6080f6f1cc185b24b3143d5e9))


### Bug Fixes

* a stopped Watch PR isn't a failing PR, the merge wait doesn't go stale, and the refusal is clear ([#176](https://github.com/ANT1OFF/gram/issues/176)) ([372b17a](https://github.com/ANT1OFF/gram/commit/372b17a8b057163d45d5ec0f4c7da932b9ea2de5))
* effort keeps a short word in a narrow composer beside a review ([#189](https://github.com/ANT1OFF/gram/issues/189)) ([140157c](https://github.com/ANT1OFF/gram/commit/140157c2873b28614560b591ba633d936ce37464))
* one status vocabulary, scoped blocker counts, one attention entry, honest tab, gauge and error states, a catch-up that never repeats ([#187](https://github.com/ANT1OFF/gram/issues/187)) ([8eb8a4a](https://github.com/ANT1OFF/gram/commit/8eb8a4a9561ca6db6855f20551469e87d1c45da4))
* pin usage-limit test clocks across midnight ([#201](https://github.com/ANT1OFF/gram/issues/201)) ([26da3d6](https://github.com/ANT1OFF/gram/commit/26da3d6fa22cbbcc3dc0fe531761211b7a5a6103))
* stabilize Board measurements and sidebar interactions ([#193](https://github.com/ANT1OFF/gram/issues/193)) ([e600d01](https://github.com/ANT1OFF/gram/commit/e600d01449db46fbd902a14870c7feb27c3dc7bb))

## [1.9.0](https://github.com/ANT1OFF/gram/compare/v1.8.0...v1.9.0) (2026-11-05)


### Features

* a visible Focus review action and named review tabs ([#149](https://github.com/ANT1OFF/gram/issues/149)) ([b2b4e0b](https://github.com/ANT1OFF/gram/commit/b2b4e0b5ce2b9af5fdb6ff81e780b6c3610fa9bb))
* Board defaults to a compact task grid ([#151](https://github.com/ANT1OFF/gram/issues/151)) ([0a590d2](https://github.com/ANT1OFF/gram/commit/0a590d27314206ae3de267ba9cc182076e57f374))
* clearer secondary text, less repeated metadata, a balanced reading column ([#169](https://github.com/ANT1OFF/gram/issues/169)) ([e81c8b4](https://github.com/ANT1OFF/gram/commit/e81c8b4256a19f5a092c460334bf779cb108bead))
* design tokens for type, spacing and radius, with a drift lint ([#158](https://github.com/ANT1OFF/gram/issues/158)) ([b297434](https://github.com/ANT1OFF/gram/commit/b297434f8ef0fc30a252a6c9659e4db6b9e129e8))
* feedback during and after actions ([#168](https://github.com/ANT1OFF/gram/issues/168)) ([1b03f1d](https://github.com/ANT1OFF/gram/commit/1b03f1dc2dabea1384b70eaffa4181beea222700))
* grouped transcript updates, honest approval states and scopes ([#152](https://github.com/ANT1OFF/gram/issues/152)) ([a9453e7](https://github.com/ANT1OFF/gram/commit/a9453e711963d991cdccc74463c8f623362612b6))
* leaner title bar, one selection style, first-run primary action ([#161](https://github.com/ANT1OFF/gram/issues/161)) ([ce412fd](https://github.com/ANT1OFF/gram/commit/ce412fd7ed83117ef88d8493c587d81067709dde))
* new workers start as Starting… with a short title; New names where it runs; first run leads with the repository ([#167](https://github.com/ANT1OFF/gram/issues/167)) ([28c40c2](https://github.com/ANT1OFF/gram/commit/28c40c2e19d5613729c284791f07573e597db90e))
* one header row over the orchestrator chat, scoped attention counts, Inbox opens on the newest ask ([#166](https://github.com/ANT1OFF/gram/issues/166)) ([0a6bbe7](https://github.com/ANT1OFF/gram/commit/0a6bbe78adaba5071e90b3bbd82977aba202389e))
* one Inbox for everything that needs you ([#156](https://github.com/ANT1OFF/gram/issues/156)) ([8f23d5e](https://github.com/ANT1OFF/gram/commit/8f23d5ef1cb9d8826af0c4f5ffcdc57cdef08479))
* orchestrator status header and a quieter chat ([#154](https://github.com/ANT1OFF/gram/issues/154)) ([7c9a8e5](https://github.com/ANT1OFF/gram/commit/7c9a8e5f23b67831d053f93d1aefcd90270b8653))
* settings without an Advanced page, regrouped and polished ([#155](https://github.com/ANT1OFF/gram/issues/155)) ([7fe025f](https://github.com/ANT1OFF/gram/commit/7fe025f1914335f31d98c5411395f0a163a8de61))
* sidebar search row, active-first rows, bounded Done ([#148](https://github.com/ANT1OFF/gram/issues/148)) ([9f1ab5a](https://github.com/ANT1OFF/gram/commit/9f1ab5a11dec52068d8c7118a2964a8f96c32192))
* text labels on right-panel tabs ([#143](https://github.com/ANT1OFF/gram/issues/143)) ([7380c69](https://github.com/ANT1OFF/gram/commit/7380c692ec1a535beabe872dcc3afc33d082aaf6))
* tighter settings, a readable Memory overview and labelled usage ([#153](https://github.com/ANT1OFF/gram/issues/153)) ([be8e6b2](https://github.com/ANT1OFF/gram/commit/be8e6b29e855645bf20ef428d4a8779f3480cd5e))


### Bug Fixes

* a worker started from New starts running, with clearer New choices ([#147](https://github.com/ANT1OFF/gram/issues/147)) ([cf3fc7e](https://github.com/ANT1OFF/gram/commit/cf3fc7e42f9f99d0cefa078bc8384708443ec328))
* ask state, quick answers and jump context stay in sync ([#150](https://github.com/ANT1OFF/gram/issues/150)) ([3356f79](https://github.com/ANT1OFF/gram/commit/3356f79080bcd3b0fe3ab844ea83643bc34326c4))
* explain why a full-auto merge still needs approval ([#164](https://github.com/ANT1OFF/gram/issues/164)) ([e57a045](https://github.com/ANT1OFF/gram/commit/e57a045b051573ad759e3b52a24f3c29e0df9a50))
* make unsettled jump wheel coverage deterministic ([#165](https://github.com/ANT1OFF/gram/issues/165)) ([1f06441](https://github.com/ANT1OFF/gram/commit/1f064417cee6b27db7d13673d6f25be45ca64039))
* **test:** deterministic local-check timeout, profiler and dreams tests ([#163](https://github.com/ANT1OFF/gram/issues/163)) ([c2df38d](https://github.com/ANT1OFF/gram/commit/c2df38df1b7c05c3d9ca1b7fc8701f317d874dc7))
* the line above the composer is the Undo alone; one count per view ([#162](https://github.com/ANT1OFF/gram/issues/162)) ([2f965bf](https://github.com/ANT1OFF/gram/commit/2f965bfd2da20a198407cce2e3a374ebf4ea6f75))

## [1.8.0](https://github.com/ANT1OFF/gram/compare/v1.7.0...v1.8.0) (2026-11-04)


### Features

* answer every ask from the Asks dock ([#125](https://github.com/ANT1OFF/gram/issues/125)) ([51e1b6c](https://github.com/ANT1OFF/gram/commit/51e1b6cac6b7fd80d802517c60bfa1b78379da75))
* calmer title bar with grouped controls and an overflow menu ([#123](https://github.com/ANT1OFF/gram/issues/123)) ([ceb74c0](https://github.com/ANT1OFF/gram/commit/ceb74c03969de0df3fb354c792f2dd161105e9f1))
* compact Board lanes and a grouped Needs-you list ([#133](https://github.com/ANT1OFF/gram/issues/133)) ([f401f75](https://github.com/ANT1OFF/gram/commit/f401f751677a603494e99cc4a46bcad841ae19ec))
* consistent icon set, hit areas and tooltips ([#140](https://github.com/ANT1OFF/gram/issues/140)) ([6013dd3](https://github.com/ANT1OFF/gram/commit/6013dd3e66324933c2f1caf46c4c382505e4225a))
* failures first, with stop and retry receipts ([#135](https://github.com/ANT1OFF/gram/issues/135)) ([08804ca](https://github.com/ANT1OFF/gram/commit/08804ca7dfc95a6bb67315f6b25883bfaf1f1e44))
* focused settings layout and an outcome-first Memory page ([#142](https://github.com/ANT1OFF/gram/issues/142)) ([582b269](https://github.com/ANT1OFF/gram/commit/582b2695fba726a758108b9aae2ce953e85e80d8))
* keep the computer awake while agents run ([#124](https://github.com/ANT1OFF/gram/issues/124)) ([8d787f9](https://github.com/ANT1OFF/gram/commit/8d787f93142bf2b8dc4a9a8f600e1d81ae327650))
* model picker search and favourites ([#129](https://github.com/ANT1OFF/gram/issues/129)) ([1507fd6](https://github.com/ANT1OFF/gram/commit/1507fd645135e44f1ced6b4d9270e7d2fce03480))
* one answer surface and one answer rule for every ask ([#134](https://github.com/ANT1OFF/gram/issues/134)) ([f3d56e8](https://github.com/ANT1OFF/gram/commit/f3d56e8baef5b94f69f8c30ebc78521fa05dbd1f))
* one History view with search and filters ([#132](https://github.com/ANT1OFF/gram/issues/132)) ([3f03994](https://github.com/ANT1OFF/gram/commit/3f03994a0c57040a6a321d14f678d3b80f613c36))
* one meaning per status colour; amber for needs-you only ([#121](https://github.com/ANT1OFF/gram/issues/121)) ([7d325a2](https://github.com/ANT1OFF/gram/commit/7d325a2b3ffe89b17d809370ed56d9404f48d20c))
* one New form and a first run that explains Gram ([#127](https://github.com/ANT1OFF/gram/issues/127)) ([f975903](https://github.com/ANT1OFF/gram/commit/f975903d433f2b56b8922436168aab45d17eef65))
* plain role, mode and autonomy explanations; first-run setup actions ([#131](https://github.com/ANT1OFF/gram/issues/131)) ([60add02](https://github.com/ANT1OFF/gram/commit/60add020185201c352ec9fcf08555fe8df885312))
* project scripts as one-click actions ([#139](https://github.com/ANT1OFF/gram/issues/139)) ([2c5ed2a](https://github.com/ANT1OFF/gram/commit/2c5ed2a2ec4685f13491100c612f57f7d7fc834c))
* roomier review panel with focus mode, wrap and ignore-whitespace ([#138](https://github.com/ANT1OFF/gram/issues/138)) ([4eff08a](https://github.com/ANT1OFF/gram/commit/4eff08ac06be8b7b882615b01095168251f8bb91))
* settings rows with descriptions and plain-language labels ([#126](https://github.com/ANT1OFF/gram/issues/126)) ([8924852](https://github.com/ANT1OFF/gram/commit/8924852072baa3a09934d9995712e70f1d641e37))
* show Codex credits to the orchestrator ([#118](https://github.com/ANT1OFF/gram/issues/118)) ([edbcd7f](https://github.com/ANT1OFF/gram/commit/edbcd7ff0d6757c5d7fad7d66e977240023a320f))
* transcript text size and width settings ([#136](https://github.com/ANT1OFF/gram/issues/136)) ([579dff0](https://github.com/ANT1OFF/gram/commit/579dff02864972cf50c7eb8cd5b858164bdc9dd5))
* undo a turn's file edits from the turn footer ([#128](https://github.com/ANT1OFF/gram/issues/128)) ([987e1d2](https://github.com/ANT1OFF/gram/commit/987e1d25656f3fcee19696924c6e8cd005aa9137))


### Bug Fixes

* header Run script leaves every chip room at 1440 px ([#141](https://github.com/ANT1OFF/gram/issues/141)) ([b0eefe5](https://github.com/ANT1OFF/gram/commit/b0eefe5593fc0c0646a071dcdbe6ebfe36afc172))
* transcript timers, stray gutter glyph and composer feedback ([#122](https://github.com/ANT1OFF/gram/issues/122)) ([549e46b](https://github.com/ANT1OFF/gram/commit/549e46bd1f7a8aeca6df2890b7b2d617dd48ecc9))

## [1.7.0](https://github.com/ANT1OFF/gram/compare/v1.6.0...v1.7.0) (2026-11-03)


### Features

* icon-only speed and mode pickers in the composer ([#115](https://github.com/ANT1OFF/gram/issues/115)) ([6392f07](https://github.com/ANT1OFF/gram/commit/6392f07a8cf3042ff5da268b56dda0bff606861f))
* icon-only speed and mode pickers in the new-thread form ([#117](https://github.com/ANT1OFF/gram/issues/117)) ([c70d37b](https://github.com/ANT1OFF/gram/commit/c70d37b397d47d2f6dcc494570b2e4f94b98e7e0))

## [1.6.0](https://github.com/ANT1OFF/gram/compare/v1.5.0...v1.6.0) (2026-11-03)


### Features

* condition wakes for schedule_wake (branch moved, thread finished) ([#108](https://github.com/ANT1OFF/gram/issues/108)) ([550545a](https://github.com/ANT1OFF/gram/commit/550545a75132094c2727114e618a8418f6710fa9))
* merge freeze that holds Gram's own merges, and a freezeLifted wake ([#110](https://github.com/ANT1OFF/gram/issues/110)) ([5096a48](https://github.com/ANT1OFF/gram/commit/5096a480cd51242e999c8b6cac680bd3bd1320fa))
* **orchestration:** wake on an upstream release or an installed version change ([#112](https://github.com/ANT1OFF/gram/issues/112)) ([efdd8fa](https://github.com/ANT1OFF/gram/commit/efdd8fa1155d20010ea2aaef88f2548598d94cd8))
* **orchestration:** wake on stuck CI and on machine load or low disk ([#111](https://github.com/ANT1OFF/gram/issues/111)) ([be9f98f](https://github.com/ANT1OFF/gram/commit/be9f98fc2802ac63f0aae063ef2034be51ada492))
* **web:** show what a worker or orchestrator is waiting on ([#113](https://github.com/ANT1OFF/gram/issues/113)) ([4a2ae69](https://github.com/ANT1OFF/gram/commit/4a2ae696f88570e7653374fdad5949cc0bb2bf01))

## [1.5.0](https://github.com/ANT1OFF/gram/compare/v1.4.0...v1.5.0) (2026-11-03)


### Features

* **voice:** a normal Voice setting with a push-to-talk key picker ([#98](https://github.com/ANT1OFF/gram/issues/98)) ([a49acdf](https://github.com/ANT1OFF/gram/commit/a49acdf8d061dcdafd0853c72e7f459ab7174e81))
* **voice:** recognise this project's names ([#102](https://github.com/ANT1OFF/gram/issues/102)) ([d306e35](https://github.com/ANT1OFF/gram/commit/d306e3518eb4e51476636a438ea56e4ec00f1be4))
* **voice:** spoken symbols, formatting and filler clean-up ([#99](https://github.com/ANT1OFF/gram/issues/99)) ([912b5e5](https://github.com/ANT1OFF/gram/commit/912b5e5732958a5441eb701b307dabf98c3db10d))
* **voice:** voice input on Linux with a TTS-free sherpa-onnx build ([#100](https://github.com/ANT1OFF/gram/issues/100)) ([4606b96](https://github.com/ANT1OFF/gram/commit/4606b96b2b01b5232c51fe068be33c5362f52433))


### Bug Fixes

* **release:** stop the release notes saying voice is missing on Linux ([#107](https://github.com/ANT1OFF/gram/issues/107)) ([fbde4f2](https://github.com/ANT1OFF/gram/commit/fbde4f27906424ff7002d1286fc859418df1e2c5))
* **worktrees:** sweep archived merged and no-PR worker worktrees ([#103](https://github.com/ANT1OFF/gram/issues/103)) ([b9ed8d4](https://github.com/ANT1OFF/gram/commit/b9ed8d4460c1ed50b8ceeb1da5da98da218ec0b0))

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
