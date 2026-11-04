export function passwordLengthError(password: string): string | undefined {
  const length = Array.from(password).length;
  if (length < 15 || length > 128) return 'Password must contain 15 to 128 characters.';
  return undefined;
}