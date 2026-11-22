# v0.4.5 — Sessions survive an update

- **Your sessions survive Update and Restart service.** A separate session
  holder now keeps every terminal running while the backend restarts. After
  an update or a restart you get the same tabs, the same panes and the same
  scrollback, and a Claude that was mid-turn keeps working through it. The
  window reconnects as before; nothing is resumed or relaunched — it is the
  same process.
- **This update itself still closes your sessions, once.** The update to
  v0.4.5 is run by the old backend, which does not have the session holder
  yet. From the next update on, your sessions stay open.
- **A backend crash no longer takes your sessions with it.** Relaunch the app
  within 10 minutes and everything re-attaches. After 10 minutes without a
  backend the sessions end as a crash did before, and History → resume
  brings the conversations back.
- **Closing the app window still ends every session** after the short grace,
  as before.
- In the rare case the session holder cannot be kept (an incompatible
  version), the Update and Restart dialogs say so beforehand: this time the
  sessions will end, and you choose "Restart anyway" or cancel.
- **The mascot steps back while you work in the app.** While the app is the
  active window, a peeking mascot slides back behind the screen edge; switch
  to another program and it peeks out again for sessions that still wait on
  you. With reduced motion it goes and comes without the slide.

Verified with Claude Code 2.1.287.
