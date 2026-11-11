// The CLI's y/N prompt for "ask" permissions. Separate from bin/ so it can be
// tested with plain streams.
import readline from 'node:readline';

/**
 * Show `message`, then ask "Proceed? [y/N]".
 * Resolves true for y/yes, false for any other answer, and null when the input
 * closes without an answer (Ctrl-D, end of a pipe).
 */
export async function confirm({ message, input = process.stdin, output = process.stderr, terminal = true } = {}) {
  output.write(`${message}\n\nProceed? [y/N] `);
  const rl = readline.createInterface({ input, output, terminal });
  const answer = await new Promise((resolve) => {
    let done = false;
    rl.question('', (a) => { done = true; resolve(a); });
    rl.on('close', () => { if (!done) resolve(null); });
  });
  rl.close();
  if (answer === null) {
    output.write('\n');
    return null;
  }
  return /^y(es)?$/i.test(answer.trim());
}
