# pi-web terminal tiles start zsh with ZDOTDIR pointing here. Put the user's ZDOTDIR back right away (so their
# .zprofile, .zshrc and .zlogin load as usual) after loading their .zshenv, and once startup is over (macOS's
# path_helper reorders PATH in login shells) move pi-web's pbcopy/pbpaste back to the front of PATH.
if [[ -n ${PI_WEB_USER_ZDOTDIR-} ]]; then
	ZDOTDIR=$PI_WEB_USER_ZDOTDIR
else
	unset ZDOTDIR
fi
unset PI_WEB_USER_ZDOTDIR
[[ -r ${ZDOTDIR:-$HOME}/.zshenv ]] && source "${ZDOTDIR:-$HOME}/.zshenv"

_pi_web_terminal_path() {
	path=("$PI_WEB_TERMINAL_BIN" ${path:#$PI_WEB_TERMINAL_BIN})
	rehash
	precmd_functions=(${precmd_functions:#_pi_web_terminal_path})
	unfunction _pi_web_terminal_path
}
precmd_functions+=(_pi_web_terminal_path)
