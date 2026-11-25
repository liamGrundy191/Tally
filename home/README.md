# Tally on the home laptop

Tally runs on this one Windows laptop (D61, D62). Everything stays on the laptop: the tickets, the
database and the reading key. Only the ticket images go out, to be read by the model.

## Once: set up the laptop

1. Install **Docker Desktop** from docker.com (the Windows version). Restart if it asks. Open it
   once, accept its terms, and in its Settings > General make sure **Start Docker Desktop when you
   sign in to your computer** is on.
2. Install **Git** from git-scm.com (the defaults are fine).
3. Open **PowerShell** (Start menu, type PowerShell) and type:
   ```
   git clone https://github.com/liamGrundy191/Tally.git $HOME\Tally
   ```
4. In File Explorer, open the `Tally\home` folder in your user folder and double-click
   **Install Tally**. It asks for:
   - the reading key (from the Anthropic console; paste it, it is not shown);
   - an email and a password (at least 12 characters) for the login.

   The first time takes about 10 minutes. At the end, a **Tally** shortcut is on the desktop and
   the browser opens Tally.

## Every day

Double-click **Tally** on the desktop. The browser opens Tally at `http://localhost:8080`. Tally
keeps you logged in for 30 days.

Tally starts by itself when the laptop starts (through Docker Desktop), so the shortcut is just
the easy way in.

## When something changes

Double-click **Update Tally** in the `Tally\home` folder. It gets the newest version and restarts
Tally. Tickets and months stay as they are.

## Problems

- **A window says "Something went wrong"**: take a photo of it. Nothing is lost; try again after
  restarting the laptop.
- **Forgotten password**: double-click **Install Tally** again. It keeps everything and offers to
  create a new login: use a different email (any address that looks like one works). The old login
  can then be removed on the Admin page.
- **The laptop dies**: the paper tickets are the backup. Set up another laptop as above and scan
  the month's tickets again.

## Where things are

- `Tally\home\tally.env`: this laptop's passwords and the reading key, written by Install. Never
  share it or put it on GitHub. Don't delete the Tally folder: without this file, Tally cannot
  open its data. To change the reading key, edit that line and run **Update Tally**.
- The data is inside Docker Desktop (the `tally-home` project). Closing a month deletes it, as
  always.
