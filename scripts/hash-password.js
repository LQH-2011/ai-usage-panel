#!/usr/bin/env node
'use strict';

/**
 * Generate the two auth values for .env / Vercel.
 *
 *   npm run hash-password                 → random password + matching hash
 *   npm run hash-password -- "my-pass"    → hash for a password you chose
 */

const crypto = require('crypto');
const { hashPassword } = require('../api/_lib');

const given = process.argv[2];
const password = given || crypto.randomBytes(12).toString('base64url');

console.log('');
console.log('AUTH_PASSWORD_HASH=' + hashPassword(password));
console.log('AUTH_TOKEN_SECRET=' + crypto.randomBytes(32).toString('hex'));
console.log('');
if (given) {
  console.log('Hashed the password you passed on the command line.');
} else {
  console.log('Generated password (SAVE THIS — it is not stored anywhere):');
  console.log('  ' + password);
}
console.log('');
