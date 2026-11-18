# PWA manual test checklist

Automated tests cover the manifest, icons, service-worker logic (in a sandbox with a fake Cache API), the registration/update flow and
the app's independence from the network. They cannot prove browser behaviour. Please run this on the deployed HTTPS site.
Tip: use a learner with data that is easy to recognise, and finish step 1 while still online.

## 1. Installation
- **Desktop Chrome:** open the site, wait 10 s, click the install icon in the address bar (or menu > "Install 中文識字"). The app opens in its own window.
  DevTools > Application > Manifest: no errors, icons shown, "Installable". Application > Service Workers: `sw.js` is *activated and running*.
  Application > Cache Storage: one `cq-shell-<hash>` cache containing `./`, `manifest.webmanifest`, `icons/*`, `js/*`.
- **Android Chrome:** menu > "Install app" / "Add to Home screen". Launch from the icon: no browser address bar (standalone). The icon is not cropped (maskable).
- **iPad Safari:** Share > "Add to Home Screen" (name should read 中文識字). Launch from the Home Screen icon: full screen, no Safari toolbar.
  (iPad Safari never shows an install prompt; the hint is in the app under 設定 > 安裝到主畫面.)

## 2. Offline
1. Open the installed app once while online and use it for a moment (this fills the cache).
2. Turn on aeroplane mode (or DevTools > Network > Offline), force-quit the app, launch it again: it opens to 選擇學習者.
3. Offline, check: switch learner, levels and characters, reading practice, writing practice with the Apple Pencil / finger, parent marking,
   revision, a writing correction ("寫五次練習"), history. Everything saves (close and relaunch offline: progress is still there).
4. Finish a full **exam** offline (needs a level with 20 characters) and look at the result and its 用時 duration.
5. Start a writing question, draw something, wait one second, force-quit, relaunch offline: 繼續 resumes the same question and the drawing is back.
6. Speech: with no zh-HK voice installed (iPad: Settings > Accessibility > Spoken Content > Voices) the app must still work; the 🔊 buttons may sound different or stay silent.

## 3. Updating without losing progress
1. Deploy a new version (change anything in `public/`, run `npm run stamp-sw`, deploy).
2. With the installed app open and online, wait a minute or reopen it: a green-bordered bar "有新版本可以使用" appears at the top.
3. Start a writing question and draw. Tap 立即更新: nothing reloads; a message asks you to finish or leave the question first. Same during marking and the five-times correction.
4. Leave the question (離開) and tap 立即更新: the app reloads once, shows the new version, and 繼續 / the drawing / correction progress are all still there.
5. Alternatively ignore the bar, close the app completely and reopen it: the new version loads, with all data intact.
6. DevTools > Application > Storage: after the update the IndexedDB databases `cantonese-quiz-profiles` and `cantonese-quiz-*` are still present; old `cq-shell-*` caches are gone.
