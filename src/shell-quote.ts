// Letters, digits and @%_+=:,./- stay bare; a leading = is quoted too, since zsh expands =cmd to the command's path.
const BARE = /^[A-Za-z0-9@%_+:,./-][A-Za-z0-9@%_+=:,./-]*$/;

export function shellQuote(value: string): string {
	return BARE.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
