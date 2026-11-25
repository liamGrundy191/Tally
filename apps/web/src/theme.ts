// The look (design pass, T5.1): calm colours, larger text, normal-case buttons, soft cards.
import { createTheme } from '@mui/material';

export const theme = createTheme({
  palette: {
    primary: { main: '#2c6e6a' },
    background: { default: '#f6f7f6', paper: '#ffffff' },
  },
  shape: { borderRadius: 10 },
  typography: {
    fontSize: 15,
    button: { textTransform: 'none', fontWeight: 600 },
    h4: { fontWeight: 600 },
    h6: { fontWeight: 600 },
  },
  components: {
    MuiCssBaseline: { styleOverrides: { a: { color: '#2c6e6a' } } },
    MuiButton: { defaultProps: { disableElevation: true } },
    MuiPaper: { defaultProps: { variant: 'outlined' } },
    MuiAppBar: {
      defaultProps: { elevation: 0, color: 'inherit' },
      styleOverrides: { root: { borderBottom: '1px solid #e0e3e1' } },
    },
  },
});
