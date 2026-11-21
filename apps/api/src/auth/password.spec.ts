import { hashPassword, verifyPassword } from './password';

describe('password hashing (argon2id)', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse');
    await expect(verifyPassword('correct horse', hash)).resolves.toBe(true);
    await expect(verifyPassword('wrong horse', hash)).resolves.toBe(false);
  });

  it('uses PHC format with OWASP parameters and a random salt', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(a).not.toBe(b);
  });

  it('rejects malformed or foreign hashes without throwing', async () => {
    await expect(verifyPassword('x', '')).resolves.toBe(false);
    await expect(verifyPassword('x', '$2b$10$bcrypthashlookslikethis')).resolves.toBe(false);
    await expect(verifyPassword('x', '$argon2id$v=19$m=0,t=2,p=1$c2FsdA$aGFzaA')).resolves.toBe(false);
    await expect(verifyPassword('x', '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA$extra')).resolves.toBe(false);
  });
});
