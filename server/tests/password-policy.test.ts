import {it,expect} from 'vitest';
import {passwordValid} from '../auth';
it('accepts eight to128 characters and rejects shorter or non-string passwords',()=>{expect(passwordValid('12345678')).toBe(true);expect(passwordValid('1234567')).toBe(false);expect(passwordValid('a'.repeat(128))).toBe(true);expect(passwordValid('a'.repeat(129))).toBe(false);expect(passwordValid(12345678)).toBe(false)});
