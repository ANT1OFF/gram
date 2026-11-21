# Changelog

## [1.35.0](https://github.com/ANT1OFF/gram/compare/v1.34.0...v1.35.0) (2026-11-21)


### Features

* **embed:** the title bar and tab say Not found on an address with no page ([#956](https://github.com/ANT1OFF/gram/issues/956)) ([ee9b3f0](https://github.com/ANT1OFF/gram/commit/ee9b3f04bb0a7ce48357abed81ee51fe510f8a7c))


### Bug Fixes

* **git:** pin checked origin URLs and neutralise repository HTTP transport keys ([#951](https://github.com/ANT1OFF/gram/issues/951)) ([9534a5b](https://github.com/ANT1OFF/gram/commit/9534a5b58c1e594ce1c9341a0aa74e7fb939df9c))
* **server:** say a hosted PR waits for its base's declared CI ([#953](https://github.com/ANT1OFF/gram/issues/953)) ([449f7a3](https://github.com/ANT1OFF/gram/commit/449f7a3af2259768b580ed5257047ab14ec612bf))
* **server:** the event sink's backfill never sends a reply still streaming ([#957](https://github.com/ANT1OFF/gram/issues/957)) ([1a4cbf6](https://github.com/ANT1OFF/gram/commit/1a4cbf6e3386d2f83f423e3eebdfb73110c255df))


### Performance Improvements

* **host:** a host for one agent starts its first session sooner ([#955](https://github.com/ANT1OFF/gram/issues/955)) ([c0ad1be](https://github.com/ANT1OFF/gram/commit/c0ad1be243c8de993485a6457943cae067ebdd15))

## [1.34.0](https://github.com/ANT1OFF/gram/compare/v1.33.0...v1.34.0) (2026-11-21)


### Features

* **shell:** name this computer to a hosted server's sign-in page ([#950](https://github.com/ANT1OFF/gram/issues/950)) ([d14bfeb](https://github.com/ANT1OFF/gram/commit/d14bfeb6eddb4ed7c0e6af3668188fbb20dc36cf))
* **web:** a hosted server's worker machine shows the server's mark, not its id ([#943](https://github.com/ANT1OFF/gram/issues/943)) ([55e1203](https://github.com/ANT1OFF/gram/commit/55e1203897aa5b978fcf39f274d31d9c248fe39b))
* **web:** the worker pane's Terminal tab is your own shell in the worker's worktree ([#942](https://github.com/ANT1OFF/gram/issues/942)) ([0afeed0](https://github.com/ANT1OFF/gram/commit/0afeed0f0fb71d1b0d2897c27b911551d5413536))


### Bug Fixes

* **git:** route every fetch and push to origin through one checked helper ([#949](https://github.com/ANT1OFF/gram/issues/949)) ([54d754b](https://github.com/ANT1OFF/gram/commit/54d754b23417fd81682139e192eb5e9f35eea98d))
* release-stable test removes its temp folders ([#947](https://github.com/ANT1OFF/gram/issues/947)) ([3311d6b](https://github.com/ANT1OFF/gram/commit/3311d6b66aa72fb8827b4b192ae301c1dec1f4fc))
* **server:** behind a GitHub route every gh call is made for a thread ([#946](https://github.com/ANT1OFF/gram/issues/946)) ([383b08e](https://github.com/ANT1OFF/gram/commit/383b08e68993f44c444eebcec3f0f69fe4f765cc))
* **server:** gate a provisioned machine's PR on CI, not a full check there ([#948](https://github.com/ANT1OFF/gram/issues/948)) ([6159c6b](https://github.com/ANT1OFF/gram/commit/6159c6b688464b85b84667c574b28782d1ba345f))
* **server:** refuse an embedding answer that names no card when the card has a key ([#940](https://github.com/ANT1OFF/gram/issues/940)) ([9653021](https://github.com/ANT1OFF/gram/commit/965302127d5ef3b7bee26213aee5bd0705860fd8))
* **server:** relay a hosted server's reason when it refuses a worker machine's start ([#944](https://github.com/ANT1OFF/gram/issues/944)) ([fe7d283](https://github.com/ANT1OFF/gram/commit/fe7d28365eaf49cdd11015536c86a8f51e5568f4))
* **web:** on a headless server the New form starts in one of its projects instead of browsing its disk ([#945](https://github.com/ANT1OFF/gram/issues/945)) ([3bb0322](https://github.com/ANT1OFF/gram/commit/3bb0322ed86eaa814f64f24e69380955394e0588))

## [1.33.0](https://github.com/ANT1OFF/gram/compare/v1.32.0...v1.33.0) (2026-11-21)


### Features

* a feature map of where things are on screen, and `bun run drive` ([#874](https://github.com/ANT1OFF/gram/issues/874)) ([d062c94](https://github.com/ANT1OFF/gram/commit/d062c940c0f11174644fe623afde4b6d26eae94c))
* a profile can limit a thread to the models its deployment serves it ([#862](https://github.com/ANT1OFF/gram/issues/862)) ([b48503b](https://github.com/ANT1OFF/gram/commit/b48503bd18d18ba37c294e651d49f01fd49a737a))
* a worker's Proof shows the screenshots its verify drivers kept ([#894](https://github.com/ANT1OFF/gram/issues/894)) ([ba14123](https://github.com/ANT1OFF/gram/commit/ba14123d2c8b4a0009a307a3d61bd2fe3205e6b8))
* a worker's Proof tool shows Gram's record of its verify drivers ([#884](https://github.com/ANT1OFF/gram/issues/884)) ([831dbce](https://github.com/ANT1OFF/gram/commit/831dbce466bba67f82accb7c8edcfb031329e5d5))
* Antigravity (Google's agent) on the user's own Google plan, on a shared ACP harness ([#928](https://github.com/ANT1OFF/gram/issues/928)) ([448f806](https://github.com/ANT1OFF/gram/commit/448f806fcacaa14f5f07a684831284ad8d4e99f9))
* **browser:** a remote thread's page browses its own machine's loopback ([#865](https://github.com/ANT1OFF/gram/issues/865)) ([7ea2b1a](https://github.com/ANT1OFF/gram/commit/7ea2b1ae440f1f232da5ac6ff6af57b2d8d59d2d))
* done reports carry Gram's record of required verify drivers, and gram's own recipe ([#870](https://github.com/ANT1OFF/gram/issues/870)) ([4cf4551](https://github.com/ANT1OFF/gram/commit/4cf4551fc7e5f0212365d905d0098eaf30da79ab))
* **embedding:** a thread's upsert carries why its last turn failed ([#879](https://github.com/ANT1OFF/gram/issues/879)) ([9b815fe](https://github.com/ANT1OFF/gram/commit/9b815fe27842f462b13e86272cb714413b046595))
* **embedding:** an orchestrator's questions and its pause reach the event sink ([#854](https://github.com/ANT1OFF/gram/issues/854)) ([2bb0b9b](https://github.com/ANT1OFF/gram/commit/2bb0b9bb8545b8f0fc0defc2905286ce14018aaf))
* **embedding:** thread.status says why a thread is in error ([#906](https://github.com/ANT1OFF/gram/issues/906)) ([f7ab3d9](https://github.com/ANT1OFF/gram/commit/f7ab3d9189ec5d7224293d87c2fc753820973610))
* Grok Build as an agent on the user's own subscription, and xAI's API as a gateway ([#868](https://github.com/ANT1OFF/gram/issues/868)) ([6ec2107](https://github.com/ANT1OFF/gram/commit/6ec21075bc3e797d650eb42a643842e52139de1c))
* **host:** let a launcher give the host a token its dials carry ([#912](https://github.com/ANT1OFF/gram/issues/912)) ([7e5cf0f](https://github.com/ANT1OFF/gram/commit/7e5cf0f86293141a1cb9521b629e88cbcaa760bc))
* **host:** loopback tunnels to a machine's own dev server ports ([#860](https://github.com/ANT1OFF/gram/issues/860)) ([5a76e7a](https://github.com/ANT1OFF/gram/commit/5a76e7a18e9c70b41b70cf03ec507729a68bab84))
* **orchestration:** a desktop's stops and releases carry the hosted server's fences, and round 28's two minor fixes ([#925](https://github.com/ANT1OFF/gram/issues/925)) ([8f4277a](https://github.com/ANT1OFF/gram/commit/8f4277a4999aea590fdc08b1d6a8e60e386efd66))
* **orchestration:** desktop workers on a signed-in hosted server's machines ([#845](https://github.com/ANT1OFF/gram/issues/845)) ([a519b80](https://github.com/ANT1OFF/gram/commit/a519b8068016d5660018147a45d07a0cd44975f5))
* **shell,web:** the user can let a local preview page use WebRTC, and an agent can't ([#926](https://github.com/ANT1OFF/gram/issues/926)) ([b6ae5b7](https://github.com/ANT1OFF/gram/commit/b6ae5b7fa8e53d6b6f84f60ab959adcb98059c88))
* **theme:** a rail token, a sunk side panel beside a list ([#889](https://github.com/ANT1OFF/gram/issues/889)) ([215aee7](https://github.com/ANT1OFF/gram/commit/215aee7c26dd09b3e20f6b33bb4a5a8b4d070c55))
* **themes:** publish the palette as data ([#910](https://github.com/ANT1OFF/gram/issues/910)) ([df52a9b](https://github.com/ANT1OFF/gram/commit/df52a9bce44f360e18bae70f9a3c68d4b09e7cca))
* verify recipes and the verify tool ([#850](https://github.com/ANT1OFF/gram/issues/850)) ([48e6cdf](https://github.com/ANT1OFF/gram/commit/48e6cdfec0147d3882525f2aa2c05d713e3015b2))
* **web:** notices go where their scope is — toasts out of the worker pane, machine diagnostics to Notification history, repeats once ([#838](https://github.com/ANT1OFF/gram/issues/838)) ([2948b0b](https://github.com/ANT1OFF/gram/commit/2948b0bf5067657e4cd84d7edba9e70fc067d74d))
* **web:** people and agents in the kit — Avatar, AvatarRow, TreeList, and sidebar marks and linked headings ([#844](https://github.com/ANT1OFF/gram/issues/844)) ([91e9a8c](https://github.com/ANT1OFF/gram/commit/91e9a8c76f6c10952a2321f8f55996e1520cfe9e))
* **web:** pick a workspace's environment, and run it on a machine of its own ([#869](https://github.com/ANT1OFF/gram/issues/869)) ([af6d6dd](https://github.com/ANT1OFF/gram/commit/af6d6dd589dd77231ff3e925372c9e3b3f688be8))


### Bug Fixes

* **agents,server,web:** no pastable command from an unsafe path, out-of-folder Grok edits ask, Codex refuses a trusted project layer on someone else's tree, folder trust counts all of .claude ([#898](https://github.com/ANT1OFF/gram/issues/898)) ([9068c97](https://github.com/ANT1OFF/gram/commit/9068c97bf7d0ec4e6d23c2a6a7299566e214e578))
* **agents:** a Codex card's id carries its session's own scope ([#917](https://github.com/ANT1OFF/gram/issues/917)) ([1a8e60c](https://github.com/ANT1OFF/gram/commit/1a8e60c978b01e87522abbbb7683a58f1d92130a))
* **agents:** Claude Code's version notice shows once per installed version, and only past a 10-patch skew ([#837](https://github.com/ANT1OFF/gram/issues/837)) ([1358a27](https://github.com/ANT1OFF/gram/commit/1358a270a81e4d6212d4bf3a733e86d189caf620))
* **browser:** browser_console reads a local page's lines, redacted ([#909](https://github.com/ANT1OFF/gram/issues/909)) ([63ee498](https://github.com/ANT1OFF/gram/commit/63ee498644e59913f6d2e090cd16b58223a0494f))
* **browser:** the image leaves the server's browser off, and an unsandboxed one serves only this machine's threads ([#905](https://github.com/ANT1OFF/gram/issues/905)) ([88ed476](https://github.com/ANT1OFF/gram/commit/88ed4767a1014880247ed2145a5a03dda694782b))
* **check:** apps/web/tsconfig.json back to plain JSON, and affected.mjs refuses one that isn't ([#890](https://github.com/ANT1OFF/gram/issues/890)) ([6ad2a54](https://github.com/ANT1OFF/gram/commit/6ad2a5497e9aa9bdedecf61e3f9d9f88e18fe526))
* **desktop,shell:** the shipped native probe runs no caller's code, and pinned and local preview pages have no WebRTC ([#913](https://github.com/ANT1OFF/gram/issues/913)) ([49b3105](https://github.com/ANT1OFF/gram/commit/49b3105c73a8db0a8915553396287a60e30ff601))
* **embedding:** a timer never ends a wait before its time ([#919](https://github.com/ANT1OFF/gram/issues/919)) ([f54b1bd](https://github.com/ANT1OFF/gram/commit/f54b1bd8555a61cd9993697fbb7fdc5f50000a4c))
* **fs:** file previews and browser evidence stay off the server's own disk for remote or shared threads ([#904](https://github.com/ANT1OFF/gram/issues/904)) ([c0cb9df](https://github.com/ANT1OFF/gram/commit/c0cb9dfcb364c080866176f3a08b3ead0ea2c62b))
* **git,server:** a GitHub read made for a thread goes out as that thread's ([#934](https://github.com/ANT1OFF/gram/issues/934)) ([bd83d93](https://github.com/ANT1OFF/gram/commit/bd83d937dcd2ffda96933243c457ab05f818bcc8))
* **git:** a merge freeze holds its own workspace's merges, every workspace's only on the user's yes ([#918](https://github.com/ANT1OFF/gram/issues/918)) ([a411367](https://github.com/ANT1OFF/gram/commit/a411367804e8de7f25b9dfcd6b28fdd724dce921))
* **git:** change requests aren't lost past the review window, and a freeze disarms only Gram's own PRs ([#915](https://github.com/ANT1OFF/gram/issues/915)) ([68f23c8](https://github.com/ANT1OFF/gram/commit/68f23c89be4077852713a5ff57c6901a6d2de2e6))
* **git:** Gram's own git runs no hook or nested repository's config, gh gets the guard, and a headless server runs nothing in its own folders ([#885](https://github.com/ANT1OFF/gram/issues/885)) ([6160ac6](https://github.com/ANT1OFF/gram/commit/6160ac6f22216ee09191ce566440ff5c6b677fd6))
* **git:** kept work comes back on a fresh clone whose main moved on ([#933](https://github.com/ANT1OFF/gram/issues/933)) ([ba59212](https://github.com/ANT1OFF/gram/commit/ba59212858d9240272ada4831d4630f6058f37d6))
* **grok:** a failed Grok Build turn says what the provider answered ([#923](https://github.com/ANT1OFF/gram/issues/923)) ([6175c47](https://github.com/ANT1OFF/gram/commit/6175c473e17cde4f4237d128ec4a8b59df4be178))
* **host:** a machine's recorded folder never claims this server's own folders ([#920](https://github.com/ANT1OFF/gram/issues/920)) ([c3e1b44](https://github.com/ANT1OFF/gram/commit/c3e1b44bdef3337136e07f68b21321e699724c74))
* **host:** hold a host's failure text and thread folders to what Gram records ([#907](https://github.com/ANT1OFF/gram/issues/907)) ([dc11023](https://github.com/ANT1OFF/gram/commit/dc11023980f0399a6ddc4b3e2ef30916a473dee3))
* **host:** hold a machine's path to a size in the placement refusal ([#924](https://github.com/ANT1OFF/gram/issues/924)) ([831073b](https://github.com/ANT1OFF/gram/commit/831073bf48c2c80cdd5e4ef48279dd7b87879e17))
* **lint:** local-checks fixture hashes its protected blob through the test-repo helper ([#897](https://github.com/ANT1OFF/gram/issues/897)) ([2eacbbd](https://github.com/ANT1OFF/gram/commit/2eacbbd14d0f1c2b0f0af6f16e954c7760dce825))
* **orchestration:** a burst of uncarded spawns starts no worker past the cap ([#914](https://github.com/ANT1OFF/gram/issues/914)) ([540ed5d](https://github.com/ANT1OFF/gram/commit/540ed5d1f5a79c7fef934baf1d2dce7602fdf6b1))
* **orchestration:** a retried release keeps its run, an older server's refusal is held off, and an expired fence is logged ([#931](https://github.com/ANT1OFF/gram/issues/931)) ([58e9853](https://github.com/ANT1OFF/gram/commit/58e9853615b2fe0624308293f796bdff137be3b8))
* **orchestration:** a user's message to a worker no longer holds back its orchestrator ([#839](https://github.com/ANT1OFF/gram/issues/839)) ([66af7e4](https://github.com/ANT1OFF/gram/commit/66af7e45fe457718e4adb086a83574bbfb248639))
* **orchestration:** embedded Gram's worker machines behave as before [#845](https://github.com/ANT1OFF/gram/issues/845) ([#892](https://github.com/ANT1OFF/gram/issues/892)) ([856ae1a](https://github.com/ANT1OFF/gram/commit/856ae1a0ef910e2489e70c5fb0583b3aec90319e))
* **orchestration:** round 17's three defects in desktop workers on hosted machines ([#891](https://github.com/ANT1OFF/gram/issues/891)) ([f228cee](https://github.com/ANT1OFF/gram/commit/f228cee3da61fbee5fa51d67db54c8db9ea8878b))
* **readers:** private threads' workspaces stay private by project, id, tool, listing and restart ([#911](https://github.com/ANT1OFF/gram/issues/911)) ([36d0e2d](https://github.com/ANT1OFF/gram/commit/36d0e2d5a6fa8579a9af76c819bc92bf2822c1b7))
* **runtime:** a session can't rewrite server-raised cards, people's messages or other threads' hook state ([#908](https://github.com/ANT1OFF/gram/issues/908)) ([bcd882c](https://github.com/ANT1OFF/gram/commit/bcd882c39840af42dbe640207d860e772f08506a))
* **security:** the Preview's local pages run no shared worker ([#831](https://github.com/ANT1OFF/gram/issues/831)) ([d4a195a](https://github.com/ANT1OFF/gram/commit/d4a195aee2aa32cc7980ff2de606d52bcf8f9497))
* **server:** a headless server's machine status names blocked threads, and New project can add a repository there, or says why not ([#849](https://github.com/ANT1OFF/gram/issues/849)) ([9870c45](https://github.com/ANT1OFF/gram/commit/9870c4526753d882eccc9026272f3ad616b8d065))
* **server:** a project's repository is the origin it was added with ([#932](https://github.com/ANT1OFF/gram/issues/932)) ([6cdc165](https://github.com/ANT1OFF/gram/commit/6cdc165c05ef095b8ebec0d4d65e2c461f7b0fd6))
* **server:** a reply never goes on over a finished one, and a hook answer binds to its request ([#922](https://github.com/ANT1OFF/gram/issues/922)) ([5c42d6a](https://github.com/ANT1OFF/gram/commit/5c42d6a94c1984cb887c5d2519938c394a98c7df))
* **server:** a server no shell runs stops its sessions on SIGTERM, within a bound ([#835](https://github.com/ANT1OFF/gram/issues/835)) ([992f411](https://github.com/ANT1OFF/gram/commit/992f4115bfc17a67964fa0ff181892a1bbdd197d))
* **server:** a worker's CI, merges, runs, review rounds and babysitting wake the worker and never notify the user ([#840](https://github.com/ANT1OFF/gram/issues/840)) ([78de1f8](https://github.com/ANT1OFF/gram/commit/78de1f8f868f8c37f1aa9fd32d5541f6fd7816cd))
* **server:** an agent's review-request and open-PR lists hold only repositories its thread works in ([#935](https://github.com/ANT1OFF/gram/issues/935)) ([eb2abb4](https://github.com/ANT1OFF/gram/commit/eb2abb4a09d9f57ec8941f51ed7cfbe3bc48872f))
* **server:** an answer is for the card it was given for, and a path read here follows this disk ([#930](https://github.com/ANT1OFF/gram/issues/930)) ([487daa3](https://github.com/ANT1OFF/gram/commit/487daa31b3f48918ad8d9bfba93361a2c8ae649a))
* **server:** behind a GitHub route, an agent reads only the repositories its thread works in ([#916](https://github.com/ANT1OFF/gram/issues/916)) ([1b1d732](https://github.com/ANT1OFF/gram/commit/1b1d732ec4c8d55ee014ab70742924bfad9351f7))
* **server:** the default-branch watch reads GitHub as the workspace's orchestrator ([#936](https://github.com/ANT1OFF/gram/issues/936)) ([3ff8583](https://github.com/ANT1OFF/gram/commit/3ff8583c3737f10e30193c7bcaf6ad7630aa0d29))
* **server:** the launch cookie alone opens nothing but the app's files ([#929](https://github.com/ANT1OFF/gram/issues/929)) ([9b5d2b0](https://github.com/ANT1OFF/gram/commit/9b5d2b0d0fade110e3d10bd9288b3a863460a493))
* **themes:** light palettes layer like dark: chrome, a page under white, white cards ([#901](https://github.com/ANT1OFF/gram/issues/901)) ([0bc2ecd](https://github.com/ANT1OFF/gram/commit/0bc2ecd392e611882467fde441f514be2fa95ca8))
* **themes:** palette.json follows [#901](https://github.com/ANT1OFF/gram/issues/901), and Petrol, Tokyo Light and Latte keep their sidebar behind the page ([#937](https://github.com/ANT1OFF/gram/issues/937)) ([b6b3160](https://github.com/ANT1OFF/gram/commit/b6b316006b38751c70f77f20a47f31d00592c79f))
* **web:** a finished worker reads Done on the Threads page, and the event sink says when a thread is archived ([#846](https://github.com/ANT1OFF/gram/issues/846)) ([28c1c9e](https://github.com/ANT1OFF/gram/commit/28c1c9e563958e395d33376dfb29d7344a034a5a))
* **web:** a send to a hosted server starts the person's machine there first, and a repository check it can't make says nothing ([#843](https://github.com/ANT1OFF/gram/issues/843)) ([8e1ce16](https://github.com/ANT1OFF/gram/commit/8e1ce160fb11675dc52acee6894de44cb6c2ecc8))
* **web:** a worker's head in the right pane says its step and its repos once, on one line ([#842](https://github.com/ANT1OFF/gram/issues/842)) ([823a75e](https://github.com/ANT1OFF/gram/commit/823a75eeeeaa2dbc509e58d67a0d7ac8eb3ef489))
* **web:** another request where the one shown was starts the ask afresh ([#921](https://github.com/ANT1OFF/gram/issues/921)) ([6e2fc31](https://github.com/ANT1OFF/gram/commit/6e2fc31a9f8fa515cc2ec0963ce04ae21b43704a))
* **web:** Bombadil's titlebar overlap rule counts only drawn controls, with a 360/768/1024 px spec ([#896](https://github.com/ANT1OFF/gram/issues/896)) ([5adc2aa](https://github.com/ANT1OFF/gram/commit/5adc2aa8a19f897325652afbc590cb898b6c6fb4))
* **web:** History's grouping control opens on its first press while the page is too busy to draw ([#834](https://github.com/ANT1OFF/gram/issues/834)) ([733b515](https://github.com/ANT1OFF/gram/commit/733b5155a0641a21bc6b2e18761261b4444221c1))
* **web:** pressing Settings while in Settings adds no history entry ([#883](https://github.com/ANT1OFF/gram/issues/883)) ([4392eb4](https://github.com/ANT1OFF/gram/commit/4392eb411d46e026cc1d1bec7e1558b883b47442))
* **web:** Settings no longer flickers as About loads, a search opens a page, or Settings opens again ([#902](https://github.com/ANT1OFF/gram/issues/902)) ([23a825d](https://github.com/ANT1OFF/gram/commit/23a825d6dfdd78fafebea25e005aea2b5d13d4a8))
* **web:** the diff stays on screen while a newer one is fetched ([#903](https://github.com/ANT1OFF/gram/issues/903)) ([588202d](https://github.com/ANT1OFF/gram/commit/588202dd91d368dc0b0a708fd14a574a55531649))
* **web:** the Folder chip names the folder in use, and Palette comes before Accent ([#848](https://github.com/ANT1OFF/gram/issues/848)) ([093969a](https://github.com/ANT1OFF/gram/commit/093969a3841957c98949f1c9004723d67b6911c6))
* **web:** the title bar folds into its "…" instead of overlapping, at every pane width ([#841](https://github.com/ANT1OFF/gram/issues/841)) ([5823899](https://github.com/ANT1OFF/gram/commit/5823899fbd72f02b2c8ea9e22f531956d8740dd2))
* **web:** the welcome card and Chat · Board no longer flicker as the shell boots ([#899](https://github.com/ANT1OFF/gram/issues/899)) ([7b09ca6](https://github.com/ANT1OFF/gram/commit/7b09ca60e51128d602656fe211f97983cc80e33e))

## [1.32.0](https://github.com/ANT1OFF/gram/compare/v1.31.0...v1.32.0) (2026-11-20)


### Features

* arch-fixes train 3 — hosts say their disk, durable restore debt per machine ([#793](https://github.com/ANT1OFF/gram/issues/793)) ([0e24257](https://github.com/ANT1OFF/gram/commit/0e24257126e3e384a3420c781cbecd83b9190f97))
* arch-fixes train 5 — host steps within budget, disk fence with ways back, open a thread whose saved work is gone ([#820](https://github.com/ANT1OFF/gram/issues/820)) ([9ffdc16](https://github.com/ANT1OFF/gram/commit/9ffdc1670c618f334de7af2ed64156719b62a069))
* forward a local CLI's model calls to a hosted server with the device's sign-in ([#818](https://github.com/ANT1OFF/gram/issues/818)) ([c66b074](https://github.com/ANT1OFF/gram/commit/c66b07459b285b58ea7b83d3ac27878738663b26))
* **profiles:** an orchestrator's profile can start its workspace's memory updates by themselves ([#787](https://github.com/ANT1OFF/gram/issues/787)) ([f974111](https://github.com/ANT1OFF/gram/commit/f97411199b2222fc731bca656013b6ad47bb7194))
* say whose work each Board line is when more than one person's is on it ([#795](https://github.com/ANT1OFF/gram/issues/795)) ([fec765d](https://github.com/ANT1OFF/gram/commit/fec765d44ab131d3b8dbb61cf7a6ce5f97516f3f))
* send work to a hosted workspace from New task, with the live-test fixes and a packaged regression ([#799](https://github.com/ANT1OFF/gram/issues/799)) ([07819d6](https://github.com/ANT1OFF/gram/commit/07819d661f7397561d5a916cfb1b9ee48323c64e))
* **web:** ask the server what it serves, and never call an RPC it lacks ([#790](https://github.com/ANT1OFF/gram/issues/790)) ([b1c655b](https://github.com/ANT1OFF/gram/commit/b1c655b866b6ed470514599c660ea35c7840517f))
* **web:** name a new workspace, on a wider two-column sheet ([#816](https://github.com/ANT1OFF/gram/issues/816)) ([9f1f60a](https://github.com/ANT1OFF/gram/commit/9f1f60abf347e3ec54b315d61d1ab830d35acd64))
* **web:** the worker pane: Workers mode, a worker open beside the chat, its switcher and the sidebar's hand-over ([#822](https://github.com/ANT1OFF/gram/issues/822)) ([d5dd2aa](https://github.com/ANT1OFF/gram/commit/d5dd2aae13b7e83657b160c311979ac4b0140f4a))


### Bug Fixes

* arch-fixes train — WIP lease, restore gate, codex 0.170, deps ([#791](https://github.com/ANT1OFF/gram/issues/791)) ([bffe6e8](https://github.com/ANT1OFF/gram/commit/bffe6e8ddd98b7cb9fa88fd1c1ce5209b4d508d0))
* arch-fixes train 2 — keep work on SIGTERM, lost-machine incident, resume re-asks owed folders ([#792](https://github.com/ANT1OFF/gram/issues/792)) ([599546a](https://github.com/ANT1OFF/gram/commit/599546a8a0c5d2c1134bb59c6ad93f06f55c8301))
* arch-fixes train 4 — restore record gaps, a ref per checkout, long steps as jobs ([#801](https://github.com/ANT1OFF/gram/issues/801)) ([6e66019](https://github.com/ANT1OFF/gram/commit/6e66019820cca42a8d8916651070216c1e1f3f20))
* **ci:** cancel only a closed pull request's own runs, never another's on a reused branch ([#814](https://github.com/ANT1OFF/gram/issues/814)) ([7179a71](https://github.com/ANT1OFF/gram/commit/7179a71b1f0e7c882aec1bf63187d96538c6b13d))
* **desktop:** keep hosted sign-in without lending permission ([#797](https://github.com/ANT1OFF/gram/issues/797)) ([75b533e](https://github.com/ANT1OFF/gram/commit/75b533e0403f3d6f760385406ea6d6f4ad237525))
* **machines:** the WIP keeper keeps after chained short turns and never cuts a keep off ([#789](https://github.com/ANT1OFF/gram/issues/789)) ([bd06e4c](https://github.com/ANT1OFF/gram/commit/bd06e4c878814e9eaeb853529c429469af246da5))
* raise the first-paint budget to 2300 kB ([#819](https://github.com/ANT1OFF/gram/issues/819)) ([2b0de0f](https://github.com/ANT1OFF/gram/commit/2b0de0f299183e6964243ad93379eb20838b2531))
* **security:** a client's message never carries what only the server sets, and endpoint tokens leave the environment ([#798](https://github.com/ANT1OFF/gram/issues/798)) ([a592b62](https://github.com/ANT1OFF/gram/commit/a592b620ba4de09e78bf1a8e14a3e198ba60383f))
* **security:** approval cards show exactly what runs ([#824](https://github.com/ANT1OFF/gram/issues/824)) ([270a4c1](https://github.com/ANT1OFF/gram/commit/270a4c1992c08a5767325d7aca7ca884f7b5a19b))
* **security:** dropped file names never type control characters, and palettes can't inject CSS ([#796](https://github.com/ANT1OFF/gram/issues/796)) ([c4152d7](https://github.com/ANT1OFF/gram/commit/c4152d757dc49d6f382d992d6108e9d9cb9ccab5))
* **security:** joined machines run only an update the publisher signed ([#825](https://github.com/ANT1OFF/gram/issues/825)) ([45b7918](https://github.com/ANT1OFF/gram/commit/45b79186eaf8fe140ae3cabb5b15ebee89699e2b))
* **security:** November scan batch 1 (hosted trust, merge approvals, review bot, folder trust, data folder, previews, markdown, update locks) ([#812](https://github.com/ANT1OFF/gram/issues/812)) ([dcf6247](https://github.com/ANT1OFF/gram/commit/dcf6247145daf860664f3fbf39d4c10df4aac44a))
* **security:** November scan batch 3 (thread readers, gateway redirects, remote sessions and folders, memory labels) ([#826](https://github.com/ANT1OFF/gram/issues/826)) ([1e7b68a](https://github.com/ANT1OFF/gram/commit/1e7b68a03e9b50eccfb5e33447b87b91a2e8d9d0))
* **security:** the desktop app reads its keys through safeStorage alone ([#823](https://github.com/ANT1OFF/gram/issues/823)) ([407f8da](https://github.com/ANT1OFF/gram/commit/407f8da627248e004b4dd58a89bdd2c335e558e6))
* **security:** the packaged Gram runs no script it is handed (RunAsNode off) ([#821](https://github.com/ANT1OFF/gram/issues/821)) ([61e840c](https://github.com/ANT1OFF/gram/commit/61e840c7eadb23ecfd4f8f7e8e78c9f8fefcc85e))
* **server:** draw a message steered into a streaming reply where it was sent ([#817](https://github.com/ANT1OFF/gram/issues/817)) ([8f1a40e](https://github.com/ANT1OFF/gram/commit/8f1a40e228b3e1751ac886af1a0f2a47f004ccde))
* **server:** keep a session waiting for a new disk's resume, log why work wasn't kept, and resume a lost machine's thread from the embedding ([#786](https://github.com/ANT1OFF/gram/issues/786)) ([eb01a7d](https://github.com/ANT1OFF/gram/commit/eb01a7d39a68026a82cadbfe00c6086e5f6f2242))
* **web:** phone-narrow windows get the phone layout, a silent thread feed asks again, and places can start a thread's path ([#828](https://github.com/ANT1OFF/gram/issues/828)) ([f5a1d5e](https://github.com/ANT1OFF/gram/commit/f5a1d5e29cd0e56ba2f1abab9e6cc48113b024de))
* **web:** the worker pane keeps the keys after an inline tool, a clicked tool tab takes them, one PR per worker ([#829](https://github.com/ANT1OFF/gram/issues/829)) ([da55f61](https://github.com/ANT1OFF/gram/commit/da55f61025b06bc50d6e0031c2ef8ef49a9cde69))
* **web:** the worker pane takes the keys, a finished worker is read only, a worker's links open its own tools ([#827](https://github.com/ANT1OFF/gram/issues/827)) ([540a34e](https://github.com/ANT1OFF/gram/commit/540a34e79f15662910f1379885ab66184b6906e2))
* workers read the memory their orchestrator reads; say why a fresh session waits and a usage window has no reading ([#813](https://github.com/ANT1OFF/gram/issues/813)) ([72e01aa](https://github.com/ANT1OFF/gram/commit/72e01aa23344bb7b9ae6c4428965679446328c32))

## [1.31.0](https://github.com/ANT1OFF/gram/compare/v1.30.0...v1.31.0) (2026-11-19)


### Features

* compact idle threads before an embedding host stops the server; a fresh session carries its last exchanges ([#772](https://github.com/ANT1OFF/gram/issues/772)) ([7bb2740](https://github.com/ANT1OFF/gram/commit/7bb2740ac8185554dd4678375fc7658bf1069396))
* **device:** send work to a hosted server, and follow, answer and stop it ([#780](https://github.com/ANT1OFF/gram/issues/780)) ([c0faae8](https://github.com/ANT1OFF/gram/commit/c0faae8c198c9784a391388cea8ff469f9c123c6))
* **embedding:** a thread start can name its permission mode ([#775](https://github.com/ANT1OFF/gram/issues/775)) ([ae7b26a](https://github.com/ANT1OFF/gram/commit/ae7b26ac936e9413ab37385c81a486f26ebd1a16))
* **embedding:** conversations a host's messages come from, a reply out through the event sink, and handing them to workers ([#778](https://github.com/ANT1OFF/gram/issues/778)) ([106bc2b](https://github.com/ANT1OFF/gram/commit/106bc2bf097fec1899af4567e61f7dff334e3a91))
* **embedding:** navigation as a dock, and auto-hide, in MountOptions.defaults; a switcher kept to the title bar ([#719](https://github.com/ANT1OFF/gram/issues/719)) ([901ebe0](https://github.com/ANT1OFF/gram/commit/901ebe02ba2e1ae5fe83425cd6bf41046828369f))
* **embed:** what a new workspace's agents can do in each GitHub repository ([#761](https://github.com/ANT1OFF/gram/issues/761)) ([28f59d0](https://github.com/ANT1OFF/gram/commit/28f59d09b74cd33be2e075c8c51c8c6944cbcba4))
* **embed:** who pays for each model, and a task preview that promises only a move the orchestrator can make ([#756](https://github.com/ANT1OFF/gram/issues/756)) ([e36ed8a](https://github.com/ANT1OFF/gram/commit/e36ed8a31e7b44127b673e6308d885130c331788))
* **first-run:** the form the first-run card opens reads the repositories first, as the card promises ([#764](https://github.com/ANT1OFF/gram/issues/764)) ([c65988a](https://github.com/ANT1OFF/gram/commit/c65988a7d39ab2e25bd12c1533655dc45fb6cc7d))
* **hosted:** bring a thread that moved to a server back to this computer ([#779](https://github.com/ANT1OFF/gram/issues/779)) ([f56431e](https://github.com/ANT1OFF/gram/commit/f56431efb9619fe705f3991e9116725bd8c0b6b6))
* **hosted:** move a thread to a server signed in to, from its menu ([#777](https://github.com/ANT1OFF/gram/issues/777)) ([3d869ec](https://github.com/ANT1OFF/gram/commit/3d869ec37d9d54af723b784c761f6a494e0bd2fa))
* **machines:** keep a worker's work off a lost machine, and resume it from the conversation ([#754](https://github.com/ANT1OFF/gram/issues/754)) ([fbff3db](https://github.com/ANT1OFF/gram/commit/fbff3db3ec68d6cdb13f2ac56b5cdffd87f239b2))
* **machines:** show what a worker's last save held, on its card, its task and its rows ([#759](https://github.com/ANT1OFF/gram/issues/759)) ([9715077](https://github.com/ANT1OFF/gram/commit/9715077b34eee033e9343815f877edd94e311799))
* memory updates on a headless control plane ([#773](https://github.com/ANT1OFF/gram/issues/773)) ([0801b70](https://github.com/ANT1OFF/gram/commit/0801b70053146227d49c58559915bb49f356461b))
* **new-task:** a repository with no workspace opens New workspace, with the task ([#771](https://github.com/ANT1OFF/gram/issues/771)) ([00d25cc](https://github.com/ANT1OFF/gram/commit/00d25cc1f2ab68e721d3baabbf0a14dd8237b5cc))
* **new-task:** say each fact once, in the embedder's noun ([#763](https://github.com/ANT1OFF/gram/issues/763)) ([0ba9b74](https://github.com/ANT1OFF/gram/commit/0ba9b74cae177fa97ff7dc42824d65298dc1c60e))
* **orchestration:** an orchestrator sends a worker to a hosted workspace and follows it ([#781](https://github.com/ANT1OFF/gram/issues/781)) ([0ded996](https://github.com/ANT1OFF/gram/commit/0ded996f2f4aace98c067eebc6712e31f0b12930))
* **orchestration:** start a session fresh on a model it can't carry over to ([#760](https://github.com/ANT1OFF/gram/issues/760)) ([6860126](https://github.com/ANT1OFF/gram/commit/6860126c67b28ab9bb1b6df08bd0a288d8e7ea96))
* **preview:** pick an element on the page to add to your next message ([#757](https://github.com/ANT1OFF/gram/issues/757)) ([5cff87c](https://github.com/ANT1OFF/gram/commit/5cff87c3b627c35e7ffd10fdde47eaf8af1a0770))
* **profiles:** start a workspace's orchestrator from a thread profile, with its workers in folders of their own ([#776](https://github.com/ANT1OFF/gram/issues/776)) ([15c422f](https://github.com/ANT1OFF/gram/commit/15c422f3ac5b7355813fb195c741fa532f15efc6))
* **server:** threads readable by one subject, for embedding hosts ([#748](https://github.com/ANT1OFF/gram/issues/748)) ([e62ee2e](https://github.com/ANT1OFF/gram/commit/e62ee2ef3e2b6912f6a461384707df99650ae0da))
* **transfer:** bring a moved thread in for a person, on their own machine ([#774](https://github.com/ANT1OFF/gram/issues/774)) ([f38468d](https://github.com/ANT1OFF/gram/commit/f38468db642a6586b30e1d6204e208886fac5f72))
* **transfer:** move one thread to another Gram with its edits ([#758](https://github.com/ANT1OFF/gram/issues/758)) ([0d81d1b](https://github.com/ANT1OFF/gram/commit/0d81d1b15018c5ba8dde3b5ae7fcd3337e833748))
* **web:** a worker sent to a server is marked where it is listed, and says so in its view ([#782](https://github.com/ANT1OFF/gram/issues/782)) ([8f20b29](https://github.com/ANT1OFF/gram/commit/8f20b290a69911c5775ccb77013dbd77c2f0ea1a))
* **workspaces:** choose models before starting a workspace ([#750](https://github.com/ANT1OFF/gram/issues/750)) ([270db0d](https://github.com/ANT1OFF/gram/commit/270db0d36f24b5d1bf7af00ab642a29e73088800))


### Bug Fixes

* **appearance:** every palette card renders the palette it shows ([5daa5b1](https://github.com/ANT1OFF/gram/commit/5daa5b116601ff5edd3a9b29eee55750d2652f50))
* **appearance:** every palette card renders the palette it shows ([#751](https://github.com/ANT1OFF/gram/issues/751)) ([5daa5b1](https://github.com/ANT1OFF/gram/commit/5daa5b116601ff5edd3a9b29eee55750d2652f50))
* **autonomy:** say only what each level does, not that branch protection is the only gate ([#768](https://github.com/ANT1OFF/gram/issues/768)) ([d75672c](https://github.com/ANT1OFF/gram/commit/d75672c4a5950bf3796cbc35791d6ae1bfeba5d5))
* **embed:** no switch offer from OpenCode, and the New workspace form in the app's word ([#753](https://github.com/ANT1OFF/gram/issues/753)) ([c3b7c38](https://github.com/ANT1OFF/gram/commit/c3b7c38d05ba66b140daf3324f86f3cd6763525a))
* **first-run:** promise neither a pull request nor a workspace that Set up doesn't make ([#769](https://github.com/ANT1OFF/gram/issues/769)) ([02604d6](https://github.com/ANT1OFF/gram/commit/02604d65d2051c4804ecc188881ad71e61743762))
* **new-task:** say who merges only where it's true, and autonomy once ([#765](https://github.com/ANT1OFF/gram/issues/765)) ([54071cb](https://github.com/ANT1OFF/gram/commit/54071cb31622b1cdab0d81bb63918d1984a9ab9a))
* **orchestrator:** the first minute after Start says nothing it can't know ([#770](https://github.com/ANT1OFF/gram/issues/770)) ([43cebd9](https://github.com/ANT1OFF/gram/commit/43cebd923dc61d054688c8d515b0e77dd7f01cff))
* **palette, usage:** Ctrl+K says what the sidebar says; credits to two places ([#755](https://github.com/ANT1OFF/gram/issues/755)) ([82cf1c5](https://github.com/ANT1OFF/gram/commit/82cf1c5cb7ee57bf8682c1cfa5082b7d68f7c388))
* **shell:** the phone header names New task and New workspace ([#762](https://github.com/ANT1OFF/gram/issues/762)) ([1dca0a9](https://github.com/ANT1OFF/gram/commit/1dca0a9da9a79799471620945f5b5349a5a19187))
* **sidebar:** a solo thread that needs you keeps its whole title ([#752](https://github.com/ANT1OFF/gram/issues/752)) ([1bad3d6](https://github.com/ANT1OFF/gram/commit/1bad3d6835c15bdcf99237146799a48a3914cdc9))
* **sidebar:** a worker's row names its pull request once ([#767](https://github.com/ANT1OFF/gram/issues/767)) ([606c057](https://github.com/ANT1OFF/gram/commit/606c057523ea89f1603aeddd43b66882b7981f53))
* **threads:** an empty workspace list offers its two ways in once ([#766](https://github.com/ANT1OFF/gram/issues/766)) ([ec0f3d7](https://github.com/ANT1OFF/gram/commit/ec0f3d7597cbd6ff3b14ff42fef148c2007ff966))
* **web:** New workspace's repository rights stop reading on a failure, with Retry; the survey is an explicit choice ([#783](https://github.com/ANT1OFF/gram/issues/783)) ([beb8e8a](https://github.com/ANT1OFF/gram/commit/beb8e8a1023c8c1ec52c9768438a547226387c5d))

## [1.30.0](https://github.com/ANT1OFF/gram/compare/v1.29.0...v1.30.0) (2026-11-18)


### Features

* **embedding:** look defaults by name, Petrol palettes, accents, background pictures and sidebar shape ([#692](https://github.com/ANT1OFF/gram/issues/692)) ([8fa52af](https://github.com/ANT1OFF/gram/commit/8fa52afba7639182c24fde6f1f32855e031ffabd))
* **web:** CodeEditor, Diff and ColorField in the embedding kit ([#743](https://github.com/ANT1OFF/gram/issues/743)) ([1075116](https://github.com/ANT1OFF/gram/commit/10751169aa418cd6e6c160e27ace1d5f671b5ced))
* **web:** sidebar waits as glyphs: a run chip, a glyph per wake condition, dated far wakes ([#716](https://github.com/ANT1OFF/gram/issues/716)) ([a558c19](https://github.com/ANT1OFF/gram/commit/a558c194fde9c8971582695e06628fe6fda6afa7))


### Bug Fixes

* **appearance:** remove Petrol from the palette choices while keeping saved selections compatible ([#747](https://github.com/ANT1OFF/gram/pull/747)).
* **machines:** start the person's own machine for a new workspace and wait for its model catalogue ([#738](https://github.com/ANT1OFF/gram/pull/738)).
* **settings:** enable recommended setup on a headless server ([#737](https://github.com/ANT1OFF/gram/pull/737)).
* **approvals:** bind merge approvals to the reviewed head and base ([#733](https://github.com/ANT1OFF/gram/pull/733)).
* **reviews:** keep every line of a reviewer's comment inside its quote ([#728](https://github.com/ANT1OFF/gram/pull/728)).
* **security:** treat a fork's pull-request checkout as untrusted code ([#726](https://github.com/ANT1OFF/gram/pull/726)).
* **hosts:** push work in progress under the host's namespace ([#722](https://github.com/ANT1OFF/gram/pull/722)).
* **machines:** a machine back after a stop opens no session until it is resumed ([#740](https://github.com/ANT1OFF/gram/issues/740)) ([7d705ea](https://github.com/ANT1OFF/gram/commit/7d705ead7288f71f410225fcbeac63ab47b29bc3))
* **machines:** a machine started on another disk can be expected; folders come back a few at once ([#741](https://github.com/ANT1OFF/gram/issues/741)) ([088e90e](https://github.com/ANT1OFF/gram/commit/088e90e031134c6488b14fa474b24ffc4185422f))
* **machines:** a thread's session opens once its own folders are back, not the whole machine's ([#742](https://github.com/ANT1OFF/gram/issues/742)) ([2837895](https://github.com/ANT1OFF/gram/commit/28378951ad9cbda8b600ca0e3f2d18d5a5167115))
* **models:** prefer GPT-6.2 Sol and Astra for subscriptions ([#745](https://github.com/ANT1OFF/gram/issues/745)) ([11e1cd3](https://github.com/ANT1OFF/gram/commit/11e1cd3289711ea45cc0c5583a5fbba10296f6c3))
* **runtime:** a person's Stop ends a limit wait; embedders see the wait ([#744](https://github.com/ANT1OFF/gram/issues/744)) ([3e3ca8c](https://github.com/ANT1OFF/gram/commit/3e3ca8c661f02b0755b50e1a7ab09c2de261292b))
* **gateway:** keep a machine provider's explicit hosted-search opt-out in its gated Codex home ([#746](https://github.com/ANT1OFF/gram/pull/746)).
* **server:** a server with no local user starts no programs, and its program settings are the local app's ([#725](https://github.com/ANT1OFF/gram/issues/725)) ([a985ea9](https://github.com/ANT1OFF/gram/commit/a985ea9ad60abce7f9f7644ba8c34728a8e8a849))
* **server:** fail closed for on-demand hosts with no owner ([#732](https://github.com/ANT1OFF/gram/issues/732)) ([19e6542](https://github.com/ANT1OFF/gram/commit/19e65421d25a5fc9b66d3a5899f9d5f149ce93a6))
* **web:** kit Page puts its actions under the line on a phone that hides the title ([#717](https://github.com/ANT1OFF/gram/issues/717)) ([96c709c](https://github.com/ANT1OFF/gram/commit/96c709c8285acd9a6bb2697f5fa66b90aa0c9ef0))
* **web:** no stray scrollbars in the panel's tab row or a roomy sidebar ([#739](https://github.com/ANT1OFF/gram/issues/739)) ([d937ef1](https://github.com/ANT1OFF/gram/commit/d937ef1e0db2fdff2547a89c488018590af75879))
* **web:** quote PowerShell's curly single quotes in dropped paths ([#724](https://github.com/ANT1OFF/gram/issues/724)) ([c7227ee](https://github.com/ANT1OFF/gram/commit/c7227ee68b622a2a562dc773ecda132995bd866f))

## [1.29.0](https://github.com/ANT1OFF/gram/compare/v1.28.0...v1.29.0) (2026-11-16)


### Features

* **app-tools:** list app tools with MCP annotations from their safety class ([#708](https://github.com/ANT1OFF/gram/issues/708)) ([22c4bad](https://github.com/ANT1OFF/gram/commit/22c4bad606dd18124ffc14f7ddf65fd5af50481c))
* **host:** hosts can keep work in progress under a namespace of their own ([#709](https://github.com/ANT1OFF/gram/issues/709)) ([82b0207](https://github.com/ANT1OFF/gram/commit/82b0207143167d245865cbbfe2383c0e3214bf3d))
* **memory:** memory updates choose what to read, write as they go and stop when they judge they're done ([#698](https://github.com/ANT1OFF/gram/issues/698)) ([122dd61](https://github.com/ANT1OFF/gram/commit/122dd6138b13c76b5461258a2defbc07aa810a97))
* New task goes to an orchestrator or a chat, no worker straight away ([#712](https://github.com/ANT1OFF/gram/issues/712)) ([aad9da0](https://github.com/ANT1OFF/gram/commit/aad9da00fbd503c9c3acd95e0bcfd1d805899489))
* **orchestration:** council reviews and other worker models ([#710](https://github.com/ANT1OFF/gram/issues/710)) ([311a7cc](https://github.com/ANT1OFF/gram/commit/311a7cc14c1def73b2e8821293eb3f30349ae2e5))
* **orchestration:** fresh session with an option to skip saving to memory first ([#711](https://github.com/ANT1OFF/gram/issues/711)) ([a7b4711](https://github.com/ANT1OFF/gram/commit/a7b47118b38415bdbed441095dfd9e5275bfe442))
* steer past an approval card, and one delivery button beside Stop ([#702](https://github.com/ANT1OFF/gram/issues/702)) ([0e469ae](https://github.com/ANT1OFF/gram/commit/0e469ae3aba4e131e384ad3fde36a713e3e58212))
* **themes:** light palettes set the sidebar and title bar a visible step off the page ([#699](https://github.com/ANT1OFF/gram/issues/699)) ([a02d72e](https://github.com/ANT1OFF/gram/commit/a02d72eb98c1d3fe4d67027a985b73999ba3a613))
* **web:** a light kit for pages shown before Gram mounts ([#707](https://github.com/ANT1OFF/gram/issues/707)) ([0b8330a](https://github.com/ANT1OFF/gram/commit/0b8330ac86a191f2df603cefbc2fc19097aa3f58))
* **web:** kit feedback and states: EmptyState, Skeleton, Shimmer, success and warning tones, plain SettingsGroup on phones ([#703](https://github.com/ANT1OFF/gram/issues/703)) ([ef2368a](https://github.com/ANT1OFF/gram/commit/ef2368abf1dd75722ea81133a4157db6083d9d73))
* **web:** kit form controls: Textarea, Checkbox, RadioGroup, described OptionGroup ([#700](https://github.com/ANT1OFF/gram/issues/700)) ([72ca1cc](https://github.com/ANT1OFF/gram/commit/72ca1cc099a1dda346e2f865bd4f247711bef043))
* **web:** kit overlays: Dialog, Sheet and Menu ([#701](https://github.com/ANT1OFF/gram/issues/701)) ([15b45d8](https://github.com/ANT1OFF/gram/commit/15b45d8beca9b5f491379ceeb7cc59ec212f4589))
* **web:** kit rich setting labels, and Page's above slot, heading level and phone title ([#706](https://github.com/ANT1OFF/gram/issues/706)) ([9a1a712](https://github.com/ANT1OFF/gram/commit/9a1a71253eb71102c46a7c27db907ae1e224ce9b))


### Bug Fixes

* **orchestration:** fix non-git claims and full-auto ownership refusals ([#704](https://github.com/ANT1OFF/gram/issues/704)) ([f981be8](https://github.com/ANT1OFF/gram/commit/f981be8fc6ba76887ace2ef7c6e36baeb329874c))

## [1.28.0](https://github.com/ANT1OFF/gram/compare/v1.27.0...v1.28.0) (2026-11-16)


### Features

* **embedding:** a GitHub relay for a headless control plane ([#690](https://github.com/ANT1OFF/gram/issues/690)) ([719ade5](https://github.com/ANT1OFF/gram/commit/719ade5a788f50827458fe872912dd7aae0dcfa7))
* **embedding:** a person's thread started in repositories, and other repositories on its machine ([#683](https://github.com/ANT1OFF/gram/issues/683)) ([c86d52c](https://github.com/ANT1OFF/gram/commit/c86d52c0e0cc6b0d44dc669ba428fa7e29e3300b))
* **embedding:** one Runs on chip for a person's on-demand machine, picks kept as theirs, and starting it again with a change ([#689](https://github.com/ANT1OFF/gram/issues/689)) ([012a5df](https://github.com/ANT1OFF/gram/commit/012a5df4fc4e19f7791846f36467e8fa40f12a25))
* **host:** OpenCode sessions run on joined machines and through a headless Gram ([#672](https://github.com/ANT1OFF/gram/issues/672)) ([25f8c51](https://github.com/ANT1OFF/gram/commit/25f8c516fd1e5265d0922de822b21c04df7423c0))
* **memory:** workers write workspace memory too, from the revision they read ([#677](https://github.com/ANT1OFF/gram/issues/677)) ([1fb1aeb](https://github.com/ANT1OFF/gram/commit/1fb1aebf28a300e3633e9ddcf860d333d57c8caf))
* **new-thread:** other repositories get a worktree of their own on the thread's branch ([#678](https://github.com/ANT1OFF/gram/issues/678)) ([55990d6](https://github.com/ANT1OFF/gram/commit/55990d6ab08d1816e905c0cd0e3e623deaa37cb2))
* **new-thread:** repositories by owner/name, and more than one for a solo thread ([#676](https://github.com/ANT1OFF/gram/issues/676)) ([ebbda8b](https://github.com/ANT1OFF/gram/commit/ebbda8b6920f4d5680dbbee293b57ad6f4eaa294))
* **orchestration:** a worker's row says where its orchestrator put it, and why ([#694](https://github.com/ANT1OFF/gram/issues/694)) ([11d50e8](https://github.com/ANT1OFF/gram/commit/11d50e8b41d55f8b10dafd71feeb53a99e617c2b))
* **orchestration:** intent-first pull requests, weighed reviews, and quick rechecks after a merge ([#680](https://github.com/ANT1OFF/gram/issues/680)) ([b3f659d](https://github.com/ANT1OFF/gram/commit/b3f659d9398df89437330e7869b8abf91d5e9914))
* **orchestration:** list_workers names only the machines a worker may go on ([#687](https://github.com/ANT1OFF/gram/issues/687)) ([29751b8](https://github.com/ANT1OFF/gram/commit/29751b839c4c21c8937f8c23add6f76bedb18d6d))
* **orchestration:** pick the orchestrator's agent and model on New task ([#688](https://github.com/ANT1OFF/gram/issues/688)) ([1b65a62](https://github.com/ANT1OFF/gram/commit/1b65a6285295eb5aabf9dfb30981fbbdc284aa99))
* **orchestration:** search the workspace's own transcripts, and check memory updates before review ([#691](https://github.com/ANT1OFF/gram/issues/691)) ([814844e](https://github.com/ANT1OFF/gram/commit/814844ec9f2645246209b4778ed372446cbc37ce))
* **orchestration:** watch a workspace's default branches after merges ([#681](https://github.com/ANT1OFF/gram/issues/681)) ([95f395f](https://github.com/ANT1OFF/gram/commit/95f395f16c0292ff86049ab7be5140b9e7039cdc))
* **settings:** a toggle for watching the default branch after merges ([#682](https://github.com/ANT1OFF/gram/issues/682)) ([8758446](https://github.com/ANT1OFF/gram/commit/8758446f2bffe8685cacd11faed2059e11228360))
* **web:** say a thread's machine is starting again while a message waits on it ([#695](https://github.com/ANT1OFF/gram/issues/695)) ([388b753](https://github.com/ANT1OFF/gram/commit/388b753030b8e3dc647002da94b12cf6744d26bb))
* **workspaces:** a shared folder each workspace's threads read and write, mirrored to their machines ([#675](https://github.com/ANT1OFF/gram/issues/675)) ([5b9f82b](https://github.com/ANT1OFF/gram/commit/5b9f82b0f5b825761ac69501a3e2ad27970c38f1))
* workers pick machine options by name, a thread reads "delivered" when nothing merged, and queued messages send when a machine joins ([#697](https://github.com/ANT1OFF/gram/issues/697)) ([3afd974](https://github.com/ANT1OFF/gram/commit/3afd9741f89f17571d311fdfc5add3c392e80c6c))


### Bug Fixes

* **host:** compare a clone's stored origin, not the insteadOf-rewritten one ([#684](https://github.com/ANT1OFF/gram/issues/684)) ([198f916](https://github.com/ANT1OFF/gram/commit/198f916f3ad6b76227b727bcfdecf459d3c71035))
* **on-demand:** a ready start whose machine is gone ends, so a new one can start ([#674](https://github.com/ANT1OFF/gram/issues/674)) ([08360f4](https://github.com/ANT1OFF/gram/commit/08360f44d1519bf8e3fc36ec4e3369e9e67da9ae))
* **server:** leave a removed machine's threads queued at boot instead of failing them each start ([#696](https://github.com/ANT1OFF/gram/issues/696)) ([7d56b19](https://github.com/ANT1OFF/gram/commit/7d56b19fc34cd22fde76eba7ecf4a57cd71d6b0d))
* **web:** keep the new-workspace sheet inside its card and read errors as repositories ([#685](https://github.com/ANT1OFF/gram/issues/685)) ([68b6505](https://github.com/ANT1OFF/gram/commit/68b6505189fbe40c3a6bf0348211f8309fed5ede))
* **web:** start card sends only the choices a person changed ([#686](https://github.com/ANT1OFF/gram/issues/686)) ([8967678](https://github.com/ANT1OFF/gram/commit/8967678b61df0d9b12b728687b2c4ecf0544ec67))

## [1.27.0](https://github.com/ANT1OFF/gram/compare/v1.26.0...v1.27.0) (2026-11-15)


### Features

* **codex:** a gated session runs on a machine's own provider when it has no ChatGPT login ([#664](https://github.com/ANT1OFF/gram/issues/664)) ([cc8402a](https://github.com/ANT1OFF/gram/commit/cc8402ae8b2b2d4e0dadf505f8dd71b4a1fab651))
* embedding features from integration/embedding ([#659](https://github.com/ANT1OFF/gram/issues/659)) ([2b5186c](https://github.com/ANT1OFF/gram/commit/2b5186c7aa99a6a4dbfb047fca3406a87579de55))
* embedding features from integration/embedding ([#671](https://github.com/ANT1OFF/gram/issues/671)) ([562cc2e](https://github.com/ANT1OFF/gram/commit/562cc2ef3ea0e8d5b7b7c5051d28eb9923d3c8d0))
* **host:** Codex sessions run on joined machines and through a headless Gram ([#653](https://github.com/ANT1OFF/gram/issues/653)) ([ab8076d](https://github.com/ANT1OFF/gram/commit/ab8076de4e650a50e0ee9f4ada45b3af8dc98c8f))


### Bug Fixes

* **app-tools:** one merge_when_ready card per merge intent, withdrawn when its PR ends ([#657](https://github.com/ANT1OFF/gram/issues/657)) ([854c610](https://github.com/ANT1OFF/gram/commit/854c610128d9fb52ba0ba9d24f4e5c4732deb6d5))
* bring the orchestrator back under its prompt budget ([#667](https://github.com/ANT1OFF/gram/issues/667)) ([7b60187](https://github.com/ANT1OFF/gram/commit/7b60187ea4700dba6071630ef0e7f62ceda65df3))
* **orchestration:** close three merge-ownership races at full autonomy ([#651](https://github.com/ANT1OFF/gram/issues/651)) ([42bdb8f](https://github.com/ANT1OFF/gram/commit/42bdb8ffefa9616a296ed0458ea5c9d9f9facb12))
* scope subscription limit holds to machine logins ([#670](https://github.com/ANT1OFF/gram/issues/670)) ([d2119b5](https://github.com/ANT1OFF/gram/commit/d2119b5d06e2e76b8ba1e1269c347fca61cfc9f8))

### From the embedding branch ([#659](https://github.com/ANT1OFF/gram/issues/659), [#671](https://github.com/ANT1OFF/gram/issues/671))

These came to `main` in two squashed merges, so they are listed by hand. Several are for apps that mount Gram's web app or for hosted deployments; those stay behind the hosted features setting, which is off by default. The branch's own copies of [#653](https://github.com/ANT1OFF/gram/issues/653) and [#664](https://github.com/ANT1OFF/gram/issues/664) are listed above.

#### Features

* a person's message for a thread, and stopping its turn, from the platform ([#650](https://github.com/ANT1OFF/gram/issues/650))
* an orchestrator can give a worker a machine of its own ([#652](https://github.com/ANT1OFF/gram/issues/652))
* tell the host provider when a worker's own machine has no work left ([#658](https://github.com/ANT1OFF/gram/issues/658))
* a delivery chip shows steer, queue and interrupt while an agent works ([#661](https://github.com/ANT1OFF/gram/issues/661))
* an orchestrator can name the environment a worker's own machine starts in ([#662](https://github.com/ANT1OFF/gram/issues/662))
* two-line worker rows in the sidebar ([#669](https://github.com/ANT1OFF/gram/issues/669))

#### Bug Fixes

* new-task route budget to 200 kB ([#656](https://github.com/ANT1OFF/gram/issues/656))
* drop the briefing placeholder that echoed the sent message ([#660](https://github.com/ANT1OFF/gram/issues/660))
* every worker row keeps its agent's mark ([#663](https://github.com/ANT1OFF/gram/issues/663))
* thread route budget to 920 kB ([#666](https://github.com/ANT1OFF/gram/issues/666))

#### Performance

* rerun the benchmarks, fix an OpenCode leak and a slow-link markdown race ([#668](https://github.com/ANT1OFF/gram/issues/668))

## [1.26.0](https://github.com/ANT1OFF/gram/compare/v1.25.0...v1.26.0) (2026-11-15)


### Features

* **orchestration:** a worker the user writes to stays its orchestrator's ([#646](https://github.com/ANT1OFF/gram/issues/646)) ([44a3d28](https://github.com/ANT1OFF/gram/commit/44a3d28e5a710af3924a40c2338b9224e6122a2d))
* **web:** an embedding app can say its machines reach the person's own repositories ([#582](https://github.com/ANT1OFF/gram/issues/582)) ([9841807](https://github.com/ANT1OFF/gram/commit/9841807c487d459c02dc7d4fc9e9ab113fcd2b7d))
* **web:** one calm Board note for a repo that runs no CI ([#634](https://github.com/ANT1OFF/gram/issues/634)) ([76f44c7](https://github.com/ANT1OFF/gram/commit/76f44c78d0ffe78e1a0ceb75b351b6f05bd268eb))


### Bug Fixes

* **orchestration:** guide agents to own a PR instead of asking the user at full auto ([#627](https://github.com/ANT1OFF/gram/issues/627)) ([085f942](https://github.com/ANT1OFF/gram/commit/085f94264c717e6562675a5e756bb01e2955f388))
* **orchestration:** silence review monitors without actionable work ([#617](https://github.com/ANT1OFF/gram/issues/617)) ([d271b81](https://github.com/ANT1OFF/gram/commit/d271b8136b0c8cc46b534a3e78ea50ada12b0f0f))
* **orchestration:** withdraw orphaned worker questions ([#618](https://github.com/ANT1OFF/gram/issues/618)) ([ef84d75](https://github.com/ANT1OFF/gram/commit/ef84d75152bf0b7a2bc2ae14f552bd5b81378967))
* **web:** a raised card's shadow keeps its rounded corners in the transcript ([#642](https://github.com/ANT1OFF/gram/issues/642)) ([52fddd3](https://github.com/ANT1OFF/gram/commit/52fddd336777cc83efce6fc0b8717cfd5f37504d))
* **web:** leave failing checks to their worker, and orphans to the orchestrator ([#628](https://github.com/ANT1OFF/gram/issues/628)) ([2632f41](https://github.com/ANT1OFF/gram/commit/2632f41441433e899d1d26458be2bc7f8065fa1d))

### From the embedding branch ([#649](https://github.com/ANT1OFF/gram/issues/649))

These came to `main` in one squashed merge, so they are listed by hand. Several are for apps that mount Gram's web app or for hosted deployments.

#### Features

* colour scripts embedded in shell commands in their own language ([#621](https://github.com/ANT1OFF/gram/issues/621))
* the embedding app can list the models it serves an agent that cannot list its own ([#622](https://github.com/ANT1OFF/gram/issues/622))
* an embedding app's own Settings, and no orchestrator menu on its pages ([#626](https://github.com/ANT1OFF/gram/issues/626))
* OpenRouter as a gateway kind ([#633](https://github.com/ANT1OFF/gram/issues/633))
* add OpenRouter in Settings by signing in or pasting a key ([#635](https://github.com/ANT1OFF/gram/issues/635))
* know OpenCode as a third agent kind ([#639](https://github.com/ANT1OFF/gram/issues/639))
* an OpenCode adapter on opencode serve ([#640](https://github.com/ANT1OFF/gram/issues/640))
* archive the Claude session with the thread, warn on a hook with no verdict, count hook heartbeats as progress ([#641](https://github.com/ANT1OFF/gram/issues/641))
* useShellLocation's navigate can replace the history entry ([#644](https://github.com/ANT1OFF/gram/issues/644))
* run threads on OpenCode ([#647](https://github.com/ANT1OFF/gram/issues/647))
* a host provider may offer choices before a person's machine starts ([#648](https://github.com/ANT1OFF/gram/issues/648))

#### Bug Fixes

* a worker question's ask is answered once, and credited to who answered it ([#613](https://github.com/ANT1OFF/gram/issues/613))
* a provider's refusal reads as the wait's line, not as a reply ([#624](https://github.com/ANT1OFF/gram/issues/624))
* hold up under a first-in-first-out thread lock ([#636](https://github.com/ANT1OFF/gram/issues/636))
* stepping out of Settings no longer bounces back to its first page ([#638](https://github.com/ANT1OFF/gram/issues/638))
* links open in a new tab when the server is hosted ([#645](https://github.com/ANT1OFF/gram/issues/645))

## [1.25.0](https://github.com/ANT1OFF/gram/compare/v1.24.0...v1.25.0) (2026-11-14)


### Features

* **embedding:** the platform can give a thread a note that wakes it ([#608](https://github.com/ANT1OFF/gram/issues/608)) ([a13694d](https://github.com/ANT1OFF/gram/commit/a13694da931da2c061ce0311f58cf79d9c501a96))
* **orchestration:** record the user's answer from a message, and withdraw a departed worker's questions ([#606](https://github.com/ANT1OFF/gram/issues/606)) ([3629c95](https://github.com/ANT1OFF/gram/commit/3629c952d01e30619467bada88386cd984239c0c))
* **web:** Conversation only is a focused mode that leaves Gram's notices out ([#603](https://github.com/ANT1OFF/gram/issues/603)) ([4bc783a](https://github.com/ANT1OFF/gram/commit/4bc783acd2f622c8354214af8c434cd5387e1720))


### Bug Fixes

* **desktop:** only pass a plain element id into the pinned-pages fixture's script ([#604](https://github.com/ANT1OFF/gram/issues/604)) ([e4852bb](https://github.com/ANT1OFF/gram/commit/e4852bb23829e3f84932c906c59ec9def487ee05))
* **desktop:** use constant scripts for pinned page clicks ([#615](https://github.com/ANT1OFF/gram/issues/615)) ([810011f](https://github.com/ANT1OFF/gram/commit/810011fadb5bfd60af7c90cecef3c4a32a60ee96))
* **embedding:** tell the agent to pass a host's refusal on as given ([#607](https://github.com/ANT1OFF/gram/issues/607)) ([b195a94](https://github.com/ANT1OFF/gram/commit/b195a94e06dac61363b89405a8349e627cc50b5d))
* **orchestration:** let a worker withdraw its question and its orchestrator close it ([#601](https://github.com/ANT1OFF/gram/issues/601)) ([3212268](https://github.com/ANT1OFF/gram/commit/321226875caa35f873a1cfcd7c069001e9aeb2be))
* **web:** restore entry budget and prevent accidental sidebar peeks ([#616](https://github.com/ANT1OFF/gram/issues/616)) ([f3561db](https://github.com/ANT1OFF/gram/commit/f3561db858757769e08964a1ceed8d73e9f6d0d3))

### From the embedding branch ([#612](https://github.com/ANT1OFF/gram/issues/612))

These came to `main` in one squashed merge, so they are listed by hand. Many are for apps that mount Gram's web app or for hosted deployments; the hosted features sit behind one setting that is off by default.

#### Features

* one setting for the hosted features, off by default ([#385](https://github.com/ANT1OFF/gram/issues/385))
* a headless control plane that runs every thread on a joined machine ([#403](https://github.com/ANT1OFF/gram/issues/403))
* provisioned hosts, registered by key and dialling a TLS listener ([#400](https://github.com/ANT1OFF/gram/issues/400))
* start a thread from a supplied profile, behind the hosted features setting ([#395](https://github.com/ANT1OFF/gram/issues/395))
* ready a host to stop, its work in progress kept on a hidden ref ([#386](https://github.com/ANT1OFF/gram/issues/386))
* move a workspace from one server to another ([#399](https://github.com/ANT1OFF/gram/issues/399))
* a thread profile's workplace can be repositories ([#404](https://github.com/ANT1OFF/gram/issues/404))
* sign-in through a fronting proxy, with actors and read-only viewers ([#391](https://github.com/ANT1OFF/gram/issues/391))
* publish Gram's core as registry packages and images from main ([#387](https://github.com/ANT1OFF/gram/issues/387))
* decision hook and event sink for an embedding deployment ([#394](https://github.com/ANT1OFF/gram/issues/394))
* pushed repository events, an outside scheduler, supplied settings and an object store for an embedding platform ([#388](https://github.com/ANT1OFF/gram/issues/388))
* stop a joined machine with its disk kept, and resume its threads on a new host ([#405](https://github.com/ANT1OFF/gram/issues/405))
* name the signed-in person to the decision hook ([#408](https://github.com/ANT1OFF/gram/issues/408))
* a fronting platform's own statement for hosts and workspace moves ([#409](https://github.com/ANT1OFF/gram/issues/409))
* a headless control plane places a profile thread on a joined machine ([#410](https://github.com/ANT1OFF/gram/issues/410))
* the event sink says who answered a card and how ([#411](https://github.com/ANT1OFF/gram/issues/411))
* device contracts and the core a lent machine checks with ([#401](https://github.com/ANT1OFF/gram/issues/401))
* mount the web app whole in another app, with added pages, navigation and a switcher ([#412](https://github.com/ANT1OFF/gram/issues/412))
* the embeddable web app exports Gram's controls and its theme's names ([#417](https://github.com/ANT1OFF/gram/issues/417))
* joined machines on different releases keep working, held by a test ([#418](https://github.com/ANT1OFF/gram/issues/418))
* a profile thread can take the id its caller made ([#419](https://github.com/ANT1OFF/gram/issues/419))
* publish the embeddable web app beside the core packages ([#420](https://github.com/ANT1OFF/gram/issues/420))
* the event sink says who started a thread, which turn a reading is of, and what is open ([#422](https://github.com/ANT1OFF/gram/issues/422))
* the command runner, grant list, ask limits and local log of a lent machine ([#414](https://github.com/ANT1OFF/gram/issues/414))
* the gate, serving and dial of a lent machine ([#423](https://github.com/ANT1OFF/gram/issues/423))
* sign a device in to a hosted server ([#428](https://github.com/ANT1OFF/gram/issues/428))
* lend this machine to a hosted server's workspaces ([#429](https://github.com/ANT1OFF/gram/issues/429))
* the ask window for a lent machine ([#430](https://github.com/ANT1OFF/gram/issues/430))
* answer a card over HTTP behind a fronting proxy, and carry its signed request as proof ([#436](https://github.com/ANT1OFF/gram/issues/436))
* the personal device whole: sign-in, lending, resume, pause and presence ([#435](https://github.com/ANT1OFF/gram/issues/435))
* install the personal device in the desktop app behind the hosted features setting ([#438](https://github.com/ANT1OFF/gram/issues/438))
* lend this computer from Settings, with each decision in a dialog the app draws ([#441](https://github.com/ANT1OFF/gram/issues/441))
* a fronting platform's own service starts a profile thread on a machine it names ([#448](https://github.com/ANT1OFF/gram/issues/448))
* list what hosted workspaces asked of this computer in Settings ([#453](https://github.com/ANT1OFF/gram/issues/453))
* an embedding app can keep the right panel to threads in a repository ([#465](https://github.com/ANT1OFF/gram/issues/465))
* an embedder can move a thread onto another machine once its own is gone ([#477](https://github.com/ANT1OFF/gram/issues/477))
* an embedder can provision hosts on demand, one person's each ([#475](https://github.com/ANT1OFF/gram/issues/475))
* a headless server lists each person's own machine's models, and an embedding app can narrow the list ([#493](https://github.com/ANT1OFF/gram/issues/493))
* a phone thread names its panels under its title ([#524](https://github.com/ANT1OFF/gram/issues/524))
* the Board names each stage under its bar, and a path bar names Memory ([#529](https://github.com/ANT1OFF/gram/issues/529))
* list_threads says which thread is an orchestrator or a worker; the phone's New hint names @ ([#534](https://github.com/ANT1OFF/gram/issues/534))
* an embedding app can give the in-memory server threads, and keep its own threads off the page of every thread ([#535](https://github.com/ANT1OFF/gram/issues/535))
* a message from a thread the embedding app shows in a place of its own names that place ([#537](https://github.com/ANT1OFF/gram/issues/537))
* a worker an orchestrator starts on another thread's ask names the thread that asked ([#542](https://github.com/ANT1OFF/gram/issues/542))
* a workspace's places are one segmented control, named on a phone too, and the Board's finished toggle says what it does ([#543](https://github.com/ANT1OFF/gram/issues/543))
* the event sink can carry each thread's messages ([#570](https://github.com/ANT1OFF/gram/issues/570))
* copy an output on another machine to the object store ([#571](https://github.com/ANT1OFF/gram/issues/571))
* each person keeps their own pane grid, saved beside the shared settings ([#569](https://github.com/ANT1OFF/gram/issues/569))
* the event sink sends the messages stored before it was sent any ([#579](https://github.com/ANT1OFF/gram/issues/579))
* Waiting on you names the person each item waits on ([#580](https://github.com/ANT1OFF/gram/issues/580))
* a thread's work in progress follows it to a replaced machine ([#574](https://github.com/ANT1OFF/gram/issues/574))
* a thread from a profile can be started before its machine ([#586](https://github.com/ANT1OFF/gram/issues/586))
* **embedding:** an ask's opening carries its questions or its plan ([#595](https://github.com/ANT1OFF/gram/issues/595))
* **embedding:** a worker's question waiting on the user is an ask the receiver can answer ([#611](https://github.com/ANT1OFF/gram/issues/611))
* **server:** read the decision hook's and event sink's token from a file ([#421](https://github.com/ANT1OFF/gram/issues/421))
* **web:** the compact sidebar is a quiet strip that opens the sidebar on hover ([#466](https://github.com/ANT1OFF/gram/issues/466))
* **web:** an embedding app can word the page of every thread and choose what New starts ([#471](https://github.com/ANT1OFF/gram/issues/471))
* **web:** an embedding app can draw its own card under its own tools' calls ([#473](https://github.com/ANT1OFF/gram/issues/473))
* **web:** an embedding app can put a thread inside its own page ([#474](https://github.com/ANT1OFF/gram/issues/474))
* **web:** an embedding app can name the browser tab ([#478](https://github.com/ANT1OFF/gram/issues/478))
* **web:** a person with no machine can start one where the deployment provides them ([#476](https://github.com/ANT1OFF/gram/issues/476))
* **web:** an embedding app can put a thread's working panels inside its own page ([#489](https://github.com/ANT1OFF/gram/issues/489))
* **web:** an embedding app can name the kinds of thread on the Threads page ([#494](https://github.com/ANT1OFF/gram/issues/494))
* **web:** an embedding app's navigation row can stay marked at other paths ([#500](https://github.com/ANT1OFF/gram/issues/500))
* **web:** an embedding app can word an embedded thread's prompt box ([#501](https://github.com/ANT1OFF/gram/issues/501))
* **web:** an embedding app's word for a solo thread also names it in the New form and a thread's header ([#505](https://github.com/ANT1OFF/gram/issues/505))
* **web:** an agent's mark wears its provider's colour, and the orchestrator's glyph an accent ([#508](https://github.com/ANT1OFF/gram/issues/508))
* **web:** an embedding app narrows and words the New form's Who does it ([#511](https://github.com/ANT1OFF/gram/issues/511))
* **web:** an embedding app has the title bar start as a path on a thread, a Board and the New form ([#512](https://github.com/ANT1OFF/gram/issues/512))
* **web:** the current page's glyph in an embedding app's navigation takes the accent ([#516](https://github.com/ANT1OFF/gram/issues/516))
* **web:** the Board is a grid; the Lanes layout is removed ([#518](https://github.com/ANT1OFF/gram/issues/518))
* **web:** the page of every thread narrows to what needs you or what is running ([#520](https://github.com/ANT1OFF/gram/issues/520))
* **web:** a workspace takes a colour of the user's choice from its row menu ([#523](https://github.com/ANT1OFF/gram/issues/523))
* **web:** collapsible navigation groups, and a sidebar peek an embedder can turn off ([#546](https://github.com/ANT1OFF/gram/issues/546))
* **web:** a turn's trace, in place of the conversation ([#547](https://github.com/ANT1OFF/gram/issues/547))
* **web:** on a phone an open panel keeps the chat's row of tabs, a threads row leads with its state's dot, and a days-long check counts days ([#552](https://github.com/ANT1OFF/gram/issues/552))
* **web:** a list of workspaces on the Threads page for embedders, and a sheet that moves a workspace to a server ([#549](https://github.com/ANT1OFF/gram/issues/549))
* **web:** Discover and Tidy up show as a short card in the chat, and an artifact's card fits a phone ([#554](https://github.com/ANT1OFF/gram/issues/554))
* **web:** an embedding page can give the app its own theme ([#548](https://github.com/ANT1OFF/gram/issues/548))
* **web:** a written file's card shows its whole name and where it sits, and says Preview ([#561](https://github.com/ANT1OFF/gram/issues/561))
* **web:** an embedding app can list the repositories Add repository offers, grouped by owner ([#568](https://github.com/ANT1OFF/gram/issues/568))
* **web:** the phone menu's person button names them and says Settings ([#577](https://github.com/ANT1OFF/gram/issues/577))
* **web:** a thread that waits for its machine says so, keeps the first message and offers Try again ([#591](https://github.com/ANT1OFF/gram/issues/591))

#### Bug Fixes

* a headless server reports no setup problems for tools it never looked for ([#469](https://github.com/ANT1OFF/gram/issues/469))
* the New form's prompt hint is one sentence on a phone ([#530](https://github.com/ANT1OFF/gram/issues/530))
* a phone's header puts a thread of the embedding app's own place under that place's name ([#538](https://github.com/ANT1OFF/gram/issues/538))
* on a narrow screen the asker of a worker's brief takes its own line instead of overlapping the delivery word ([#545](https://github.com/ANT1OFF/gram/issues/545))
* a workspace's Memory keeps the path bar and its places, and drops the title row they already say ([#551](https://github.com/ANT1OFF/gram/issues/551))
* on a phone a finished Board card says how it ended once, newest first, and Memory's empty Decisions says so in plain words ([#556](https://github.com/ANT1OFF/gram/issues/556))
* Memory's Decisions and History read in its column, and on a phone its tab row fades where it scrolls on ([#562](https://github.com/ANT1OFF/gram/issues/562))
* keep an embedding app's home at / instead of jumping to the server's last focused thread ([#558](https://github.com/ANT1OFF/gram/issues/558))
* give a thread's new session its recent turns when its agent's conversation is gone ([#563](https://github.com/ANT1OFF/gram/issues/563))
* a headless server files a cloned repository's origin for its machine to clone ([#566](https://github.com/ANT1OFF/gram/issues/566))
* long plain text keeps its start in a message event, and a copy from another machine comes in time, whole, and again after it failed ([#589](https://github.com/ANT1OFF/gram/issues/589))
* a person's work goes only on their own machine where hosts start on demand; a host for threads placed by name is never a default ([#588](https://github.com/ANT1OFF/gram/issues/588))
* **embedding:** a worker question's ask is answered once, and credited to who answered it ([#613](https://github.com/ANT1OFF/gram/issues/613))
* **persistence:** upgrade a 1.24.0 database, whose 0009 was user_messages ([#612](https://github.com/ANT1OFF/gram/issues/612))
* **server:** the embedding token opens its paths when sign-in is fronted ([#415](https://github.com/ANT1OFF/gram/issues/415))
* **server:** a profile thread placed on a machine clones only on that machine ([#517](https://github.com/ANT1OFF/gram/issues/517))
* **web:** let embedders renew a rejected session ([#472](https://github.com/ANT1OFF/gram/issues/472))
* **web:** a hidden tab's late timers no longer drop its RPC socket ([#479](https://github.com/ANT1OFF/gram/issues/479))
* **web:** the phone menu's foot is a bar of its own, and Since you left has a rule under it ([#491](https://github.com/ANT1OFF/gram/issues/491))
* **web:** a thread come to in a narrow window opens on its conversation, and the shell has a skip link ([#496](https://github.com/ANT1OFF/gram/issues/496))
* **web:** a page's heading is not said twice under a title bar that names it, and a long model note wraps ([#499](https://github.com/ANT1OFF/gram/issues/499))
* **web:** an approval card says what the step is for before its input ([#502](https://github.com/ANT1OFF/gram/issues/502))
* **web:** the New form's button says Start for an embedding app with its own word for a solo thread ([#506](https://github.com/ANT1OFF/gram/issues/506))
* **web:** the New form's button says Start agent for an embedding app with its own word for a solo thread ([#509](https://github.com/ANT1OFF/gram/issues/509))
* **web:** on a phone the list of threads keeps its lists and New task on one row, and a worker's take-over line wraps instead of being cut ([#555](https://github.com/ANT1OFF/gram/issues/555))
* **web:** links meet the text floor in dark, a disabled button reads as disabled, and the skip link has its target ([#557](https://github.com/ANT1OFF/gram/issues/557))
* **web:** a row waiting for approval names the tool and the wait, and a pull request's folded reviewers line shows its facts uncut ([#559](https://github.com/ANT1OFF/gram/issues/559))
* **web:** warning words hold the text floor on their own tint, and the person's message has a fill of its own in light ([#567](https://github.com/ANT1OFF/gram/issues/567))
* **web:** the switcher's solo threads stay inside the menu, Settings folds its list on a phone when mounted, and option tracks fit their choices ([#565](https://github.com/ANT1OFF/gram/issues/565))
* **web:** on a phone Settings keeps its picker and search on one row and a workspace's row fits, and Current orchestrator is a row of its card ([#572](https://github.com/ANT1OFF/gram/issues/572))
* **web:** a chosen filter, a segment, a chip and inline code show their fill in light ([#573](https://github.com/ANT1OFF/gram/issues/573))
* **web:** the Diff toolbar keeps to two rows in a narrow panel ([#575](https://github.com/ANT1OFF/gram/issues/575))
* **web:** the phone menu's theme row lines up with its neighbours and its track shows in dark ([#583](https://github.com/ANT1OFF/gram/issues/583))
* **web:** a pull request's failing checks come first with Inspect in their row, and a trace names the step that waits on approval ([#581](https://github.com/ANT1OFF/gram/issues/581))
* **web:** an embedding app's Tailwind build writes the package's classes again, so the two share one order ([#576](https://github.com/ANT1OFF/gram/issues/576))
* **web:** Try again is asked once per thread, and comes back when the wait never begins again ([#594](https://github.com/ANT1OFF/gram/issues/594))

#### Performance Improvements

* **web:** keep the move-to-server sheet and the peek sheet's body off the first paint ([#560](https://github.com/ANT1OFF/gram/issues/560))

## [1.24.0](https://github.com/ANT1OFF/gram/compare/v1.23.0...v1.24.0) (2026-11-14)


### Features

* agents propose MCP servers, added only on the user's approval ([#514](https://github.com/ANT1OFF/gram/issues/514)) ([fca60b6](https://github.com/ANT1OFF/gram/commit/fca60b6be7a52c9be029dd8dad27bb55092ebdf2))
* choose which surfaces Codex computer use reaches ([#528](https://github.com/ANT1OFF/gram/issues/528)) ([c799c63](https://github.com/ANT1OFF/gram/commit/c799c63c32d7af3399dff56e3a34314eb4681e8c))
* let a lent browser ask before each action ([#541](https://github.com/ANT1OFF/gram/issues/541)) ([4077399](https://github.com/ANT1OFF/gram/commit/4077399ac1164a989a62e71ffabfc26f8cabdd9e))
* let a workspace limit a lent browser to its own sites and apps ([#536](https://github.com/ANT1OFF/gram/issues/536)) ([93e7899](https://github.com/ANT1OFF/gram/commit/93e7899e4a329f750ddd0f6dd953de6ba5db49f6))
* let agents browse on the server without the desktop app ([#544](https://github.com/ANT1OFF/gram/issues/544)) ([011c01c](https://github.com/ANT1OFF/gram/commit/011c01c5e1feb4cce549fd48f3e10af8c500a757))
* limit a lent browser to listed sites and Mac apps ([#531](https://github.com/ANT1OFF/gram/issues/531)) ([5b93938](https://github.com/ANT1OFF/gram/commit/5b939381ad7c63b68ce17a743311c09c4b4f00ac))
* **orchestration:** a digest says when it lands in the middle of the user's conversation ([#593](https://github.com/ANT1OFF/gram/issues/593)) ([64155c5](https://github.com/ANT1OFF/gram/commit/64155c58b4623ffcfb9850df91e61c017268882e))
* **orchestration:** autonomy decides only code and GitHub, and how an orchestrator talks to the user ([#590](https://github.com/ANT1OFF/gram/issues/590)) ([8c8174b](https://github.com/ANT1OFF/gram/commit/8c8174b37ddcb108a8adb4e5a29d7a305998392a))
* pass on the user's answer from the record, and one notification for asks that wait together ([#587](https://github.com/ANT1OFF/gram/issues/587)) ([8d74ac2](https://github.com/ANT1OFF/gram/commit/8d74ac24fad133e35b680890345f037406f27ea6))
* say when a lent browser isn't ready ([#519](https://github.com/ANT1OFF/gram/issues/519)) ([cf80610](https://github.com/ANT1OFF/gram/commit/cf80610a50e7aec4620b9dd4329a8e67bb7e4720))
* watch and drive the server's browser from the Preview tab ([#550](https://github.com/ANT1OFF/gram/issues/550)) ([a538963](https://github.com/ANT1OFF/gram/commit/a538963d08a6287c66135827e6c78f144087d9c7))
* **web:** browser asks say what they would do in words, and the browser chip says "held back" ([#585](https://github.com/ANT1OFF/gram/issues/585)) ([a7dc72c](https://github.com/ANT1OFF/gram/commit/a7dc72c8503beeea0bc9e73868164195327764b3))
* **web:** Conversation only keeps the images a tool call returned, and has a shortcut ([#597](https://github.com/ANT1OFF/gram/issues/597)) ([153f8e7](https://github.com/ANT1OFF/gram/commit/153f8e76aa932229f6d03e026cc71f3bb5a8d219))
* **web:** Conversation only, a switch that takes tool calls and reasoning out of every transcript ([#592](https://github.com/ANT1OFF/gram/issues/592)) ([eea13dd](https://github.com/ANT1OFF/gram/commit/eea13dd3df3b75206810bebe8e0373e708c8cba7))
* **web:** the server's page says who drives in one line, with a worded Hand back ([#584](https://github.com/ANT1OFF/gram/issues/584)) ([bb44eff](https://github.com/ANT1OFF/gram/commit/bb44effed29f6693b0deff0d8703e61a990e971f))


### Bug Fixes

* a window whose launch cookie was lost reloads onto the running server ([#532](https://github.com/ANT1OFF/gram/issues/532)) ([5225592](https://github.com/ANT1OFF/gram/commit/522559259884fc4b68fc9c3c543679cca063bd31))
* keep a joined machine connected through a stall of a few seconds ([#533](https://github.com/ANT1OFF/gram/issues/533)) ([9e94333](https://github.com/ANT1OFF/gram/commit/9e9433356bb64b8473f036c7fb1ef47f115d7a97))
* keep a thread edit made while a one-flag clear was in flight ([#540](https://github.com/ANT1OFF/gram/issues/540)) ([d89fb79](https://github.com/ANT1OFF/gram/commit/d89fb7944a5ad3afa7c8dd8a2ef7f21e245daaee))
* keep an embedding app's home at / instead of jumping to the server's last focused thread ([#553](https://github.com/ANT1OFF/gram/issues/553)) ([6d3468d](https://github.com/ANT1OFF/gram/commit/6d3468de5387d7ae15f9779f668eb087e0011e97))
* **web:** Your browser nests what Codex computer use reaches under its switch, and the allowed lists' examples no longer repeat an entry ([#578](https://github.com/ANT1OFF/gram/issues/578)) ([25e8e0d](https://github.com/ANT1OFF/gram/commit/25e8e0dd6eb7d0d820ae0fab111aec9ee1abeebe))


### Performance Improvements

* read only the user messages each caller needs ([#539](https://github.com/ANT1OFF/gram/issues/539)) ([f5dd278](https://github.com/ANT1OFF/gram/commit/f5dd278e04a22fef6e1f517951596bab578be7fa))

## [1.23.0](https://github.com/ANT1OFF/gram/compare/v1.22.0...v1.23.0) (2026-11-13)


### Features

* a broken keybindings.json or scripts.json keeps the last good version ([#483](https://github.com/ANT1OFF/gram/issues/483)) ([06c2e87](https://github.com/ANT1OFF/gram/commit/06c2e879b9835ac73ab6cbe1186a63384cbc1af9))
* bring a thread's terminal back after a restart, under its old screen ([#482](https://github.com/ANT1OFF/gram/issues/482)) ([ecea3e0](https://github.com/ANT1OFF/gram/commit/ecea3e03b9e5736032df9e3260f7dd8993a89ef0))
* fold superseded models under Legacy models in the model picker ([#490](https://github.com/ANT1OFF/gram/issues/490)) ([f591f02](https://github.com/ANT1OFF/gram/commit/f591f02a678cb410537b78c7a4103ad10876e169))
* keep agents running after Gram quits (opt-in), and take them up again on reopen ([#492](https://github.com/ANT1OFF/gram/issues/492)) ([a354251](https://github.com/ANT1OFF/gram/commit/a354251642d099e1054fb3bd466aa4ae7413c558))
* pin a page an agent drafted, in a session of its own ([#503](https://github.com/ANT1OFF/gram/issues/503)) ([9a72c01](https://github.com/ANT1OFF/gram/commit/9a72c0113ab23913828303ed8dd9cda807a2fc75))
* show MCP permission prompts as approval cards in Codex and Claude threads ([#515](https://github.com/ANT1OFF/gram/issues/515)) ([6bcb814](https://github.com/ANT1OFF/gram/commit/6bcb8149ba65f7875238645a68bbbd0e4885f3e0))
* show which machine a thread runs on, wherever it is listed ([#497](https://github.com/ANT1OFF/gram/issues/497)) ([71da823](https://github.com/ANT1OFF/gram/commit/71da823353d74a1c4d69fcf02109c51ea32a4548))
* the built-in browser opens any web page ([#481](https://github.com/ANT1OFF/gram/issues/481)) ([6627dc8](https://github.com/ANT1OFF/gram/commit/6627dc8f80067ae154c3061e40e98306d6bf4c71))
* write an agent guide (AGENTS.md) into Gram's data folder at every start ([#486](https://github.com/ANT1OFF/gram/issues/486)) ([14a73bc](https://github.com/ANT1OFF/gram/commit/14a73bc11428753020576b88052c641ed3c7190b))


### Bug Fixes

* name worker models through the agent's model catalogue ([#484](https://github.com/ANT1OFF/gram/issues/484)) ([f9c897b](https://github.com/ANT1OFF/gram/commit/f9c897b8bf380130fcbac421a1a0ded40179ffe7))
* tune role prompts and two tool descriptions from a prompt audit ([#485](https://github.com/ANT1OFF/gram/issues/485)) ([1c4ca40](https://github.com/ANT1OFF/gram/commit/1c4ca408903dbfb4430bf3832063993549745272))


### Performance Improvements

* a headline benchmark, and compressed files and socket for phones and slow links ([#495](https://github.com/ANT1OFF/gram/issues/495)) ([d2d3ce2](https://github.com/ANT1OFF/gram/commit/d2d3ce2eb400f588588d6824bb76a39cdcc1524e))
* faster reconnect and slow-link launch, packages in a file that survives updates ([#498](https://github.com/ANT1OFF/gram/issues/498)) ([33921cb](https://github.com/ANT1OFF/gram/commit/33921cb254ad560cab04e0668cbae50c732e50dd))
* **git:** ask origin for the base branch it has first ([#507](https://github.com/ANT1OFF/gram/issues/507)) ([f1ad392](https://github.com/ANT1OFF/gram/commit/f1ad392f93d1aab7659dcbc2fda7a34a7da17d02))
* redial when the network returns; streaming, scrolling, approvals, worker start and outages in the benchmark; route budgets ([#504](https://github.com/ANT1OFF/gram/issues/504)) ([d562732](https://github.com/ANT1OFF/gram/commit/d5627320bda5ed8ddad27cfc94896ede7f44d9b6))
* **web:** load a Settings page's sections with the page, not with the page list ([#513](https://github.com/ANT1OFF/gram/issues/513)) ([8f34973](https://github.com/ANT1OFF/gram/commit/8f34973b54d7991bc6b7ba39812466fed1e2e859))

## [1.22.0](https://github.com/ANT1OFF/gram/compare/v1.21.0...v1.22.0) (2026-11-12)


### Features

* dismiss a document chip above the composer ([#468](https://github.com/ANT1OFF/gram/issues/468)) ([7931e39](https://github.com/ANT1OFF/gram/commit/7931e3964d8f38ca992d6bd7f83ac3b6dd7abd60))
* lend a thread your own browser (Claude in Chrome, Codex computer use) ([#470](https://github.com/ANT1OFF/gram/issues/470)) ([e4ad41a](https://github.com/ANT1OFF/gram/commit/e4ad41ab1dac5df98024648525119466c7432f7d))
* the Inbox is one dialog in every mode ([#467](https://github.com/ANT1OFF/gram/issues/467)) ([89e7ffa](https://github.com/ANT1OFF/gram/commit/89e7ffae17e69e7773efe78ee0d8c466e7d177f9))


### Bug Fixes

* await device restoration and worker wrap-ups in tests ([#457](https://github.com/ANT1OFF/gram/issues/457)) ([fbbe2a4](https://github.com/ANT1OFF/gram/commit/fbbe2a44482b31cb7fcda84947500c653875e710))

## [1.21.0](https://github.com/ANT1OFF/gram/compare/v1.20.0...v1.21.0) (2026-11-11)


### Features

* a provisioned host's operator can allow Claude Code's key auth, and lent-computer requests in Settings ([#456](https://github.com/ANT1OFF/gram/issues/456)) ([b3b18de](https://github.com/ANT1OFF/gram/commit/b3b18ded377370dd8a4c8977043beb25edaabcb4))
* Continue in… for threads and workers ([#449](https://github.com/ANT1OFF/gram/issues/449)) ([9b2fadb](https://github.com/ANT1OFF/gram/commit/9b2fadb8f4d7c88b2e926a9fb59572f11c657513))
* profile threads started by a fronting platform, lending from Settings, and embedding shell pieces ([#452](https://github.com/ANT1OFF/gram/issues/452)) ([26f7f78](https://github.com/ANT1OFF/gram/commit/26f7f78e5bd51ceb92384923e233c7fd7b631d7f))
* the orchestrator's switch carries a note and recent turns ([#451](https://github.com/ANT1OFF/gram/issues/451)) ([1c341a3](https://github.com/ANT1OFF/gram/commit/1c341a31f7743b5a9b7b50e3b2ee7d1a82914c0e))

## [1.20.0](https://github.com/ANT1OFF/gram/compare/v1.19.0...v1.20.0) (2026-11-11)


### Features

* embedding and hosting Gram's core, behind the hosted features setting ([#440](https://github.com/ANT1OFF/gram/issues/440)) ([64ab8c0](https://github.com/ANT1OFF/gram/commit/64ab8c050b9990ad87883153c0c42004b484d72f))
* Gram's own messages steer into a running turn by default ([#407](https://github.com/ANT1OFF/gram/issues/407)) ([88def10](https://github.com/ANT1OFF/gram/commit/88def107aed9dc8ddce44d82b742e930aa2e5cc2))
* show the model's name on the composer chip and an icon for each mode ([#397](https://github.com/ANT1OFF/gram/issues/397)) ([bf6ba1e](https://github.com/ANT1OFF/gram/commit/bf6ba1efb8a01a54fc8a36cdb62d8486bf828073))
* sidebar waits fit as a glyph and the PR number, words on hover ([#402](https://github.com/ANT1OFF/gram/issues/402)) ([9a14f21](https://github.com/ANT1OFF/gram/commit/9a14f218ade5ed5d1d60ccd88c411cd1fec56f18))
* the handoff for a switched thread ([#433](https://github.com/ANT1OFF/gram/issues/433)) ([2a51891](https://github.com/ANT1OFF/gram/commit/2a518918f3ed7d553b5c895090b2ab5c6786c714))
* What's New lists what changed in the recommended models ([#381](https://github.com/ANT1OFF/gram/issues/381)) ([385a518](https://github.com/ANT1OFF/gram/commit/385a518735f5f46a8194b00f4a7e96eca982694b))


### Bug Fixes

* calculate routine sleeps when timer fibers start ([#393](https://github.com/ANT1OFF/gram/issues/393)) ([c548a4b](https://github.com/ANT1OFF/gram/commit/c548a4bd98defeca303149dd6c4470a630347b13))
* dev-servers test binds a free port ([#437](https://github.com/ANT1OFF/gram/issues/437)) ([2ce8e32](https://github.com/ANT1OFF/gram/commit/2ce8e320f332f4046d6170d5790d82f3e116ece1))
* device log test builds its long log without 20,000 appends ([#447](https://github.com/ANT1OFF/gram/issues/447)) ([8778535](https://github.com/ANT1OFF/gram/commit/87785357bf462f2b420f8e330dec5a44b0ae5b09))
* refuse a cross-harness model in setModel ([#390](https://github.com/ANT1OFF/gram/issues/390)) ([0b21fad](https://github.com/ANT1OFF/gram/commit/0b21fad0703f299a2ca6bc15e8bc97984e937d61))
* refuse a steer into a thread whose folder is gone ([#382](https://github.com/ANT1OFF/gram/issues/382)) ([baab263](https://github.com/ANT1OFF/gram/commit/baab263e7bc4e4dd799e85e009afddb84855de77))
* retry a refused update stop once by itself, showing its progress ([#398](https://github.com/ANT1OFF/gram/issues/398)) ([eb26d27](https://github.com/ANT1OFF/gram/commit/eb26d279a813e7dc09369c5c2d2d57373d11d256))
* stop the update tree check refusing its own ps read ([#396](https://github.com/ANT1OFF/gram/issues/396)) ([26e8e0e](https://github.com/ANT1OFF/gram/commit/26e8e0e9575d147df96f5956c961da74cd88a8bc))

## [1.19.0](https://github.com/ANT1OFF/gram/compare/v1.18.0...v1.19.0) (2026-11-10)


### Features

* Codex workers run in Auto on Codex's auto-review where no outward gate holds ([#370](https://github.com/ANT1OFF/gram/issues/370)) ([5e689fc](https://github.com/ANT1OFF/gram/commit/5e689fc4227d38b8c73a1f42f24d7030b30a16fe))
* joined machines report their models ([#376](https://github.com/ANT1OFF/gram/issues/376)) ([09fcb66](https://github.com/ANT1OFF/gram/commit/09fcb666463371e18104493c4385661e2a2415d0))
* mark model slots as following or yours, with Follow recommended and the effort cap ([#380](https://github.com/ANT1OFF/gram/issues/380)) ([6640995](https://github.com/ANT1OFF/gram/commit/664099538dac87cb9c46ab2a68066cfdcf12f265))
* Recommended setup switch, its Details and the turn-on sheet ([#377](https://github.com/ANT1OFF/gram/issues/377)) ([6588d60](https://github.com/ANT1OFF/gram/commit/6588d609775e8459426a65065ab83c9aecb9f197))
* retry at higher effort, then the next tier, as a ledger hint ([#378](https://github.com/ANT1OFF/gram/issues/378)) ([f21cc11](https://github.com/ANT1OFF/gram/commit/f21cc11537a6d7a55a613a8919ffa8c4da0ab569))
* the orchestrator knows the tiers and the effort ladder ([#375](https://github.com/ANT1OFF/gram/issues/375)) ([a976f90](https://github.com/ANT1OFF/gram/commit/a976f90b94dc9185790c6f2dd3bd1a84fa02c8f2))


### Bug Fixes

* a Codex-only workspace starts on a Codex orchestrator ([#372](https://github.com/ANT1OFF/gram/issues/372)) ([3ed8e3a](https://github.com/ANT1OFF/gram/commit/3ed8e3a6b95ab7a119c7b98e6de428fdb0540617))
* helpers follow the cheap tier, title at medium and the rest at low ([#369](https://github.com/ANT1OFF/gram/issues/369)) ([bd3a655](https://github.com/ANT1OFF/gram/commit/bd3a6550453a458ed97667246b5e6620b29f5ff3))
* order moved-base fixture checks after reconciliation ([#379](https://github.com/ANT1OFF/gram/issues/379)) ([7e5e630](https://github.com/ANT1OFF/gram/commit/7e5e630aaac00acb090a8a1f9e8f0cc1107c873a))
* preserve event routine wake deadlines during recovery ([#368](https://github.com/ANT1OFF/gram/issues/368)) ([bf3451d](https://github.com/ANT1OFF/gram/commit/bf3451d4cdfc03f51b166dc3d035cc96e8a0b021))

## [1.18.0](https://github.com/ANT1OFF/gram/compare/v1.17.0...v1.18.0) (2026-11-10)


### Features

* a calmer Workers tab, Memory's title alone, and sidebar edges that fit ([#357](https://github.com/ANT1OFF/gram/issues/357)) ([d5cef76](https://github.com/ANT1OFF/gram/commit/d5cef762e61ad3dd900e642ae2510632ad60ce27))
* a feature with nothing to report is one line in the orchestrator's chat ([#358](https://github.com/ANT1OFF/gram/issues/358)) ([4a182a7](https://github.com/ANT1OFF/gram/commit/4a182a709376f41bb27137cc2a08c667c89417e3))
* a machine's row is its name and state, with its details and rare actions put away ([#361](https://github.com/ANT1OFF/gram/issues/361)) ([8e4df36](https://github.com/ANT1OFF/gram/commit/8e4df36bc00d6237e359d1e819d466285a520b63))
* a new thread's form is the prompt and where it runs, with the rest under More options ([#365](https://github.com/ANT1OFF/gram/issues/365)) ([27a0077](https://github.com/ANT1OFF/gram/commit/27a0077bcff503fe8d0be47d8e1471606b6ecf87))
* docs by the task that wrote them, one doc per subject, and excerpts that say what was found ([#362](https://github.com/ANT1OFF/gram/issues/362)) ([f0d9b3a](https://github.com/ANT1OFF/gram/commit/f0d9b3a4eee69c2dfe96a306fa69c8ea24380473))
* model slots can follow a tier ([#367](https://github.com/ANT1OFF/gram/issues/367)) ([89bf39d](https://github.com/ANT1OFF/gram/commit/89bf39db11e9e4115b9c7a87b6e1912341de3f18))
* one frame for a reply's code blocks and tables, their buttons at the corner on hover ([#355](https://github.com/ANT1OFF/gram/issues/355)) ([b9f7700](https://github.com/ANT1OFF/gram/commit/b9f77004a7952ff7fec69ed066493e1d748b4aec))
* open a running command's output in the right panel ([#340](https://github.com/ANT1OFF/gram/issues/340)) ([017cf3a](https://github.com/ANT1OFF/gram/commit/017cf3a016f8e4b76796b1d690093d4a0d23b891))
* start a one-off chat in any folder on a joined machine ([#348](https://github.com/ANT1OFF/gram/issues/348)) ([d919aba](https://github.com/ANT1OFF/gram/commit/d919abacacd747c4923f9cc7e47577cb5136bbd7))
* steer, queue or interrupt a message to a working thread from the composer ([#366](https://github.com/ANT1OFF/gram/issues/366)) ([b6a8f0e](https://github.com/ANT1OFF/gram/commit/b6a8f0e97f91228feda107c3f00ceb00b0e962cb))
* the recommended model table and resolver ([#360](https://github.com/ANT1OFF/gram/issues/360)) ([e8c9c7c](https://github.com/ANT1OFF/gram/commit/e8c9c7ccbf647f0a3037f373ce411e5da10e8f8b))


### Bug Fixes

* a phone says what runs and what waits, instead of Stopped and the state twice ([#356](https://github.com/ANT1OFF/gram/issues/356)) ([78958f9](https://github.com/ANT1OFF/gram/commit/78958f9800ab702a1588892f0f8a7a42f977bea3))
* a steer cancels nothing, Gram's notices queue, and only an explicit interrupt cuts off tool calls ([#363](https://github.com/ANT1OFF/gram/issues/363)) ([11f8cdd](https://github.com/ANT1OFF/gram/commit/11f8cdd7437cebf03d5af6f3c8f4bc6799f20c55))
* a whole amber outline on request cards, state dots on feature cards, and a proper empty orchestrator chat ([#352](https://github.com/ANT1OFF/gram/issues/352)) ([618ba18](https://github.com/ANT1OFF/gram/commit/618ba183afdd61d3f8022eff17700b2070cafe3a))
* buttons say their words once, an update names its version once, and folds take the app's chevron ([#354](https://github.com/ANT1OFF/gram/issues/354)) ([a872961](https://github.com/ANT1OFF/gram/commit/a872961bb82cccc26c1ae64a4a1e80c2a03fb1d7))
* document spawn_worker's reserved machine names and refuse a blank one ([#343](https://github.com/ANT1OFF/gram/issues/343)) ([bdfae13](https://github.com/ANT1OFF/gram/commit/bdfae1361cd560a49b50fa14043c7b015feef4ba))
* end a tool a host restart cut off as interrupted, and stop redialling after a leave ([#349](https://github.com/ANT1OFF/gram/issues/349)) ([2dd5061](https://github.com/ANT1OFF/gram/commit/2dd50611fd1d0d39fcbc37022d24bafb506ea949))
* even columns in History and the Board's Done, one-line file ages in Memory, and a quieter short Inbox ([#353](https://github.com/ANT1OFF/gram/issues/353)) ([4334662](https://github.com/ANT1OFF/gram/commit/4334662eadb647e1ee11b2794c0f48e8206694af))
* find a joined machine's just-opened PR without waiting for its host's git state ([#347](https://github.com/ANT1OFF/gram/issues/347)) ([96fb4d3](https://github.com/ANT1OFF/gram/commit/96fb4d37e1e5c2523cdbc68fc3942d805ef89793))
* guide Claude workers away from shell safety prompts ([#364](https://github.com/ANT1OFF/gram/issues/364)) ([860a5f7](https://github.com/ANT1OFF/gram/commit/860a5f7daa10b224ef5a5f37863ca9c2d6c635f0))
* keep a diff row's file name, drop its zero counts, and stop its actions ghosting over them ([#351](https://github.com/ANT1OFF/gram/issues/351)) ([9da8e34](https://github.com/ANT1OFF/gram/commit/9da8e3497e28ebcaf96bd839a6e0daf920d1ccdf))
* resume sessions after an orderly host restart, and redial a silent link ([#346](https://github.com/ANT1OFF/gram/issues/346)) ([e1a8be0](https://github.com/ANT1OFF/gram/commit/e1a8be0df4f19d7dce49c5fe7ea37340d99928ab))
* set Tailscale Serve up again by itself, and say when Tailscale is down here ([#344](https://github.com/ANT1OFF/gram/issues/344)) ([bf2b36c](https://github.com/ANT1OFF/gram/commit/bf2b36ca87d475ca907a09d659bfae632def277c))
* the PR panel counts what blocks a merge once, and a check's link says Inspect job ([#359](https://github.com/ANT1OFF/gram/issues/359)) ([d22a40f](https://github.com/ANT1OFF/gram/commit/d22a40fcf3713f28a40c45d70f0d94fea8ce1282))
* verify release checksums without a platform shasum ([#345](https://github.com/ANT1OFF/gram/issues/345)) ([169206f](https://github.com/ANT1OFF/gram/commit/169206f44d71fe55e6320017bd88a1641f60bb3e))


### Performance Improvements

* cut a release without rerunning CI's tests or waiting on a coupled Linux build ([#341](https://github.com/ANT1OFF/gram/issues/341)) ([bd21537](https://github.com/ANT1OFF/gram/commit/bd21537914c23bee99c94748ef2997e4abde5b0b))

## [1.17.0](https://github.com/ANT1OFF/gram/compare/v1.16.0...v1.17.0) (2026-11-09)


### Features

* keep every workspace in the sidebar, never in At rest ([#317](https://github.com/ANT1OFF/gram/issues/317)) ([3b1bfb8](https://github.com/ANT1OFF/gram/commit/3b1bfb8d0e5fe4193d46a7376e1240a237fed706))
* say why a joined machine is offline, and update one that needs it ([#322](https://github.com/ANT1OFF/gram/issues/322)) ([e412205](https://github.com/ANT1OFF/gram/commit/e412205f618b659738cd7dc0b54e7340293a7790))
* sign in a joined machine to Claude with a setup-token from this Mac, with consent per machine ([#314](https://github.com/ANT1OFF/gram/issues/314)) ([daa678b](https://github.com/ANT1OFF/gram/commit/daa678b664492f1c489f629f7ff6ac0085c2fe62))
* update joined machines over their own connection, with rollback and automatic updates ([#336](https://github.com/ANT1OFF/gram/issues/336)) ([4ab126c](https://github.com/ANT1OFF/gram/commit/4ab126cd4e130996aa6ac3019308cd4d20950ab4))


### Bug Fixes

* continue a joined machine's turns after its host restarts ([#326](https://github.com/ANT1OFF/gram/issues/326)) ([326206b](https://github.com/ANT1OFF/gram/commit/326206b442d4e0c0414cc50aa783a6544e999d23))
* count a joined machine's worktree as the worker's own for full-auto merges ([a4456e4](https://github.com/ANT1OFF/gram/commit/a4456e40b50efd5e4608c9678ae6255ff4c87039))
* identify a joined machine's checkout by its machine and path ([#330](https://github.com/ANT1OFF/gram/issues/330)) ([d1fe808](https://github.com/ANT1OFF/gram/commit/d1fe80898fce9c195bb3eddfa5190117db8bee61))
* keep a joined machine's terminals reachable after a reconnect, and forks on the conversation's machine ([#329](https://github.com/ANT1OFF/gram/issues/329)) ([a32e106](https://github.com/ANT1OFF/gram/commit/a32e106aae1e94306058f1d8d15a1f243477a60e))
* pin machine dials to their access, keep dial nonces across restarts, and only leave once the host stopped ([#324](https://github.com/ANT1OFF/gram/issues/324)) ([a566866](https://github.com/ANT1OFF/gram/commit/a566866de4c7e2a3a8972aa29026b03fd98e0a60))
* read a joined machine's files on that machine, and carry attachments there ([#328](https://github.com/ANT1OFF/gram/issues/328)) ([959fb68](https://github.com/ANT1OFF/gram/commit/959fb6851be99252e49b02e4afd1c506583ff7b3))
* read a joined machine's terminals and agent pids on that machine ([#323](https://github.com/ANT1OFF/gram/issues/323)) ([03acabf](https://github.com/ANT1OFF/gram/commit/03acabffbb89c98c9ea99c0cecec1d8474d35e52))
* run a joined machine's local check there, and gate its merge on it ([#333](https://github.com/ANT1OFF/gram/issues/333)) ([6f0965e](https://github.com/ANT1OFF/gram/commit/6f0965e23fb9714e7d172c457a1cf3cf117e272d))
* secure joined-machine installation and validate cached apps ([#320](https://github.com/ANT1OFF/gram/issues/320)) ([5bde789](https://github.com/ANT1OFF/gram/commit/5bde7892e71bb7b427b2b80be98202dfb2cbf6ea))
* validate joined-machine repositories and worker admission ([#325](https://github.com/ANT1OFF/gram/issues/325)) ([9bfbae5](https://github.com/ANT1OFF/gram/commit/9bfbae588d1e5ed765a692894814b3794082d32a))

## [1.16.0](https://github.com/ANT1OFF/gram/compare/v1.15.1...v1.16.0) (2026-11-09)


### Features

* fold memory changes into the tool run around them ([#311](https://github.com/ANT1OFF/gram/issues/311)) ([1650037](https://github.com/ANT1OFF/gram/commit/1650037a7f9f150c254edb211cb7e5505765d869))
* pick a machine where a thread starts, and show and fix its Claude sign-in ([#318](https://github.com/ANT1OFF/gram/issues/318)) ([e35ec15](https://github.com/ANT1OFF/gram/commit/e35ec15cbac243c6908bfbad6e51a48dfe4c421f))


### Bug Fixes

* keep a joined machine's message when its send or steer doesn't arrive ([#327](https://github.com/ANT1OFF/gram/issues/327)) ([18b89aa](https://github.com/ANT1OFF/gram/commit/18b89aaa4135787634bd930ecc23ef37252a6ea2))
* keep a joined machine's sessions running through a dropped connection ([81ed140](https://github.com/ANT1OFF/gram/commit/81ed140be95a531beb0ffa1c99c27f06a3d98d5d))
* stop asking this disk about a joined machine's folders, and key checkouts once per sweep ([b20f7f6](https://github.com/ANT1OFF/gram/commit/b20f7f6d97891d900655dac55508acc67d2021e7))

## [1.15.1](https://github.com/ANT1OFF/gram/compare/v1.15.0...v1.15.1) (2026-11-09)


### Bug Fixes

* never resolve a joined machine's paths on this one ([24517b4](https://github.com/ANT1OFF/gram/commit/24517b4f738a980b65d86393b70740b96e3d2cd6))

## [1.15.0](https://github.com/ANT1OFF/gram/compare/v1.14.0...v1.15.0) (2026-11-09)


### Features

* add a machine over SSH, confirmed by the fingerprint it prints ([#309](https://github.com/ANT1OFF/gram/issues/309)) ([1d8eb7c](https://github.com/ANT1OFF/gram/commit/1d8eb7c8709248696233fd83b066394171951561))
* join a machine with one command, served by the main Gram ([#307](https://github.com/ANT1OFF/gram/issues/307)) ([6929869](https://github.com/ANT1OFF/gram/commit/69298695e63c711d64e1641761fb908bac039950))
* phone Needs you cards with worded actions, wrapped code, a clean usage axis ([#304](https://github.com/ANT1OFF/gram/issues/304)) ([1a25635](https://github.com/ANT1OFF/gram/commit/1a25635003ffa78138fdea9546177702fdaf8403))
* pick a joined machine for a new thread or a spawned worker, and tag its workers ([#306](https://github.com/ANT1OFF/gram/issues/306)) ([1179ccc](https://github.com/ANT1OFF/gram/commit/1179ccca67ec360969b5aa31ac6f97559782d477))
* place a new worktree thread on a joined machine ([#303](https://github.com/ANT1OFF/gram/issues/303)) ([267301d](https://github.com/ANT1OFF/gram/commit/267301d37ec59839277d77c43ea8cdde2552de71))
* turn on access over Tailscale from Add a machine ([#308](https://github.com/ANT1OFF/gram/issues/308)) ([710c2bd](https://github.com/ANT1OFF/gram/commit/710c2bd54be56e81b11b13c8d74598d618981164))

## [1.14.0](https://github.com/ANT1OFF/gram/compare/v1.13.0...v1.14.0) (2026-11-09)


### Features

* a phone layout for phone access ([#298](https://github.com/ANT1OFF/gram/issues/298)) ([46a8b15](https://github.com/ANT1OFF/gram/commit/46a8b15af0b1f678a78f51e83f87099230acb363))
* a run timeline for each turn ([#295](https://github.com/ANT1OFF/gram/issues/295)) ([b9ad3c7](https://github.com/ANT1OFF/gram/commit/b9ad3c70c5d67e7d6dbe4602d5155c09acd261d1))
* answer an agent's question in your own words beside its choices ([#294](https://github.com/ANT1OFF/gram/issues/294)) ([b1f19c4](https://github.com/ANT1OFF/gram/commit/b1f19c401e7d90d5143cd9016d88e51b7f81a256))
* joined machines as worker hosts, with their own clones and worktrees ([#301](https://github.com/ANT1OFF/gram/issues/301)) ([fe625af](https://github.com/ANT1OFF/gram/commit/fe625af5afd0bd94db9c99e91ab823b76233913b))
* let another machine join and dial in as a worker host ([#299](https://github.com/ANT1OFF/gram/issues/299)) ([424e063](https://github.com/ANT1OFF/gram/commit/424e06363bd3916725f5cf5890d6a898bdeefcdc))
* list, add, confirm and remove other machines in Settings → Machines ([#300](https://github.com/ANT1OFF/gram/issues/300)) ([050fefb](https://github.com/ANT1OFF/gram/commit/050fefb1bd941dccc5f5b5170876c308bd51c1c0))
* make a thread's new and restored worktrees in the host process ([#288](https://github.com/ANT1OFF/gram/issues/288)) ([8c974a8](https://github.com/ANT1OFF/gram/commit/8c974a850a080b20013a24036e86ff807e3b11cb))
* open Claude sessions in the host process ([#292](https://github.com/ANT1OFF/gram/issues/292)) ([9fcbc18](https://github.com/ANT1OFF/gram/commit/9fcbc185b4760854805c00d37ffab2192111ccb9))
* open terminals in the host process ([#290](https://github.com/ANT1OFF/gram/issues/290)) ([8b2e983](https://github.com/ANT1OFF/gram/commit/8b2e9830344402887ca451dc94c2c4f576510ab1))
* routines that start on events ([#289](https://github.com/ANT1OFF/gram/issues/289)) ([42dfbe6](https://github.com/ANT1OFF/gram/commit/42dfbe6745ce700182db7f26779e9c76ed24eb41))
* run the server and web app in a Linux container ([#297](https://github.com/ANT1OFF/gram/issues/297)) ([df75e6e](https://github.com/ANT1OFF/gram/commit/df75e6e7bd361a00ef7dacb4be3c5e506c51f2ef))
* run this machine's worker host as its own process, over the host protocol ([#285](https://github.com/ANT1OFF/gram/issues/285)) ([b8fcc27](https://github.com/ANT1OFF/gram/commit/b8fcc27356fc26c7d02b9a646e4c2f7effe6d8ce))
* run worktrees and local git state through the host process ([#287](https://github.com/ANT1OFF/gram/issues/287)) ([bfa3922](https://github.com/ANT1OFF/gram/commit/bfa39222d4ddbb4362af7a7b3e0a45c59119eaa4))
* show the tokens each turn used on its reply ([#293](https://github.com/ANT1OFF/gram/issues/293)) ([5087dd4](https://github.com/ANT1OFF/gram/commit/5087dd408cd4fe5d06421718051df41b38d00053))
* tidy the phone layout: no key hints, 44 px buttons, two-line History ([#302](https://github.com/ANT1OFF/gram/issues/302)) ([57dfa37](https://github.com/ANT1OFF/gram/commit/57dfa37743f3bf3f060975a69ea17c86c9e54a12))


### Bug Fixes

* deterministic read-worker seal test ([#296](https://github.com/ANT1OFF/gram/issues/296)) ([8f952a3](https://github.com/ANT1OFF/gram/commit/8f952a3d085967b62315d8f6f3f83263d80bbac8))
* event routines keep their events and re-seed on a new repository ([#291](https://github.com/ANT1OFF/gram/issues/291)) ([9af04b9](https://github.com/ANT1OFF/gram/commit/9af04b9bddffc12e0bd30b8babf3de2b16c69e0a))

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
