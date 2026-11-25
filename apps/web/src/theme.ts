// The look (D63): an official form. Navy and white, hairline-ruled fields, one stamp per month.
// Navy owns every action and live state; red is only for removing and errors.
import { createTheme } from '@mui/material';

const NAVY = '#1b2a4a';
const RULE = '#c9d3e6';

export const theme = createTheme({
  palette: {
    primary: { main: NAVY, contrastText: '#ffffff' },
    error: { main: '#b42318' },
    success: { main: '#1f7a4d' },
    text: { primary: '#1b2a4a', secondary: '#4a587a' },
    divider: RULE,
    background: { default: '#eef1f6', paper: '#ffffff' },
  },
  shape: { borderRadius: 6 },
  typography: {
    fontFamily: '"Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif',
    fontSize: 15,
    button: { textTransform: 'none', fontWeight: 600, fontSize: '1rem' },
    h4: { fontWeight: 700, letterSpacing: '-0.01em' },
    h5: { fontWeight: 700 },
    h6: { fontWeight: 700 },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        a: { color: NAVY, textUnderlineOffset: '0.2em' },
        '::selection': { background: '#c9d3e6', color: NAVY },
        ':focus-visible': { outline: `2px solid ${NAVY}`, outlineOffset: 2 },
        html: { scrollbarColor: `${RULE} transparent` },
        'td, dd': { fontVariantNumeric: 'tabular-nums' },
      },
    },
    // Large, obvious targets for a mouse user who is new to computers (PRODUCT.md).
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: { root: { padding: '8px 20px', minHeight: 42 } },
    },
    MuiPaper: {
      defaultProps: { variant: 'outlined' },
      styleOverrides: { root: { borderRadius: 4 } },
    },
    MuiAppBar: {
      defaultProps: { elevation: 0, color: 'primary' },
    },
    MuiTableCell: { styleOverrides: { head: { fontWeight: 700, color: '#4a587a' } } },
  },
});
