// pnpm seed:admin: creates the first admin (accounts are invite-only, PLAN section 11).
// It asks for the email and password; nothing about the account is written into the code.
import { createInterface } from 'node:readline/promises';
import { createPrisma } from './db.ts';
import { AccountError, createAdmin } from './users/create-admin.ts';

/** Reads a line typed at the keyboard without showing it (for the password). */
function askHidden(question: string): Promise<string> {
  process.stdout.write(question);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  let typed = '';
  return new Promise((resolve) => {
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === '\u0003') process.exit(130); // Ctrl+C
        if (c === '\r' || c === '\n') {
          stdin.off('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write('\n');
          resolve(typed);
          return;
        }
        typed = c === '\u007f' || c === '\b' ? typed.slice(0, -1) : typed + c;
      }
    };
    stdin.on('data', onData);
  });
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Put it in .env (see .env.example).');
  process.exit(1);
}
const questions = [
  'Admin email: ',
  'Password (at least 12 characters, not shown): ',
  'Type the password again: ',
];
const answers: string[] = [];
if (process.stdin.isTTY) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  answers.push(await rl.question(questions[0]!));
  rl.close();
  for (const q of questions.slice(1)) answers.push(await askHidden(q));
} else {
  // Input fed in by a script: read its lines in order (none is lost, nothing is shown).
  const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  for (const q of questions) {
    console.log(q);
    answers.push((await lines.next()).value ?? '');
  }
}
const [email, password, again] = answers as [string, string, string];
if (again !== password) {
  console.error('The two passwords are different. Nothing was created.');
  process.exit(1);
}
const prisma = createPrisma(url);
try {
  const user = await createAdmin(prisma, email, password);
  console.log(`Admin ${user.email} created. Log in with this email and password.`);
} catch (error) {
  if (!(error instanceof AccountError)) throw error;
  console.error(`${error.message} Nothing was created.`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
