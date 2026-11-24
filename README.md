# Tally

Turns scanned paper shift tickets into Excel sheets of hours per workplace, for a staffing agency. Every value is checked by rules or a person; nothing is guessed. How to run it and how it is built: `CLAUDE.md` and `docs/PLAN.md`.

## If something goes wrong

**Nothing is urgent.** The tickets are on paper. You can count by hand as before, or wait and upload later. Nothing is lost while the site is down.

**Where things are:** the server, the database, file storage (AWS), error alerts (Sentry) and the code (GitHub). The logins are listed in the table filled in when the server is set up.

| What happened                                                                          | What to do                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The site does not open**                                                             | _You can do this:_ open `<site>/api/health`. "ok" means the app works: try another browser or connection. Otherwise restart the server from the provider's dashboard. If the site does not come back, _call a developer_.                                                                                     |
| **An error email from Sentry**                                                         | _You can do this:_ forward it to the developer. It holds no names or ticket values.                                                                                                                                                                                                                           |
| **The server is lost**                                                                 | _Call a developer:_ a new server with the same release, and the settings from their safe copy (where the table above says). No tickets are lost: they are not kept on the server.                                                                                                                             |
| **The database is lost or damaged**                                                    | _Call a developer:_ restore the newest backup (kept 7 days). Then _you_ upload again anything uploaded after that backup (it is read, and paid for, again), and _a developer_ closes again any month that comes back open (its scans are gone).                                                               |
| **A month was closed by mistake**                                                      | It cannot be reopened. The Excel and PDFs downloaded at closing are that month. Tickets for it that arrive later are marked "Month already closed": add them to the Excel by hand. Within 7 days, _a developer_ can rebuild that month's Excel from a backup; after that nothing is left anywhere, by design. |
| **Scans went missing**                                                                 | Within a day, _a developer_ can bring them back. After that, _you_ remove those tickets and scan the paper again.                                                                                                                                                                                             |
| **A password or key leaked**                                                           | _You can do this_ for a person's password: disable the account on the Admin page (it logs them out at once), then _call a developer_. For the reading key, the AWS or database keys: _call a developer_ to replace them at once.                                                                              |
| **"Reading this upload stopped", or a month stuck "being closed" for more than a day** | _Call a developer._                                                                                                                                                                                                                                                                                           |

**Test the recovery** once when the site goes live and then once a year: _a developer_ restores a backup into a copy and checks it. Write down the date.

## Running it for real (for the developer)

- **Where it runs (Q18–Q20):** one DigitalOcean server (Frankfurt) running `docker/compose.prod.yml` (Caddy, API, worker), a DigitalOcean managed Postgres with 7-day backups, files in AWS S3 (Frankfurt, `eu-central-1`), error alerts in Sentry (EU). All accounts are in Liam's name; every login is in his password manager.
- **Settings:** `/opt/tally/.env` on the server (mode 600); secrets go in only through `sudo bash /opt/tally/set-secrets.sh`. A copy lives in the password manager.
- **Deploy:** push a tag (`git tag v1.2.3 && git push origin v1.2.3`). GitHub runs the checks, builds the images, copies them to the server, runs the migrations and starts the new release. A failed migration leaves the running release untouched.
- **Roll back:** GitHub, Actions, Deploy, Run workflow, choosing the earlier tag under "Use workflow from".
- **First-time setup and the go-live checks:** `docs/DECISIONS.md`, D60.
