# Grading the reader on real tickets (`pnpm poc`)

This program reads a folder of scanned tickets the same way the finished system will, then
checks the results against what is really written on each ticket. You type those true values
into `truth.csv`.

## 1. Put the scans in a folder

Put PDFs, JPEGs and PNGs in one folder, for example `C:\tally-test\`. Each PDF page and each
image is one ticket. Real tickets never go into the project folder.

## 2. Make the truth file (free)

```
pnpm poc --input C:\tally-test --template
```

This writes `C:\tally-test\truth.csv`, with one row per ticket: the file name and page are
already filled in.

## 3. Fill it in, in Excel

1. Open `truth.csv` in Excel.
2. Before you type, select columns C to I. Right-click, choose **Format Cells**, then **Text**.
   This stops Excel from changing dates and times.
3. For each ticket, type exactly what is **written on the paper**, even if it is a mistake.
   - Name and workplace as written.
   - The date as `DD/MM/YY`, for example `10/11/26`.
   - Times as `HH:MM`, for example `08:30`.
   - Leave a cell empty if the box on the ticket is empty.
   - `voided`: type `yes` if the whole ticket is crossed out, otherwise leave it empty.
4. Save it with **File → Save As → CSV UTF-8 (Comma delimited)**. A plain "CSV" garbles Hebrew,
   and the program will refuse it.

## 4. Check everything (free)

```
pnpm poc --input C:\tally-test
```

This checks the truth file, lists any problems, shows the dates it found (look out for day and
month swapped), and shows the estimated cost. It reads nothing and spends nothing.

## 5. Read and grade (costs money)

```
pnpm poc --input C:\tally-test --yes --batch
```

`--batch` uses Anthropic's batch service at **half the price**, about 14.5 cents per ticket (D38). It is
slower: the reading happens in up to three rounds, and each round usually finishes within an hour
(at most 24 hours). Leave the window open until it is done. If you stop it with Ctrl+C, it cancels
the batch so it stops costing.

Without `--batch` it reads straight away, at about twice that. It stops by itself at 1.5 times the estimate. When it
finishes, it prints the report and saves three files in `scan-output\poc-<date and time>\`:

- `report.txt`: the summary.
- `mistakes.csv`: one row per mistake. Open it in Excel.
- `readings.json`: everything each read saw, for Claude to look into.

These files hold real names, so they stay on this computer.

## Reading the report

- **Gate G0** is the most important line. It passes only when no wrong date or time got through
  without a flag, and no crossed-out ticket was missed.
- **ACCEPTED WRONG** counts the dangerous mistakes: values the system accepted that are not what
  is written.
- **person: right guess** means the box went to a person, and the right answer was already filled
  in, so it takes one click.
- **Total confirmed by the times** counts uses of the risky rule D30. If it was ever wrong, the
  rule should be removed.
