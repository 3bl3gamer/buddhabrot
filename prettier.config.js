module.exports = {
	printWidth: 110,
	useTabs: true,
	tabWidth: 4,
	semi: false,
	singleQuote: true,
	trailingComma: 'all',
	arrowParens: 'avoid',
	overrides: [
		{
			files: '*.html',
			options: {
				printWidth: 250,
				htmlWhitespaceSensitivity: 'strict', //а то он половину '<br />' переносит на новую строку
			},
		},
	],
}
