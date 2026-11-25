// The pages and who may open them. The API checks access again on every request.
import { AppBar, Box, Button, Container, Menu, MenuItem, Toolbar, Typography } from '@mui/material';
import { useState } from 'react';
import {
  Link,
  NavLink,
  Navigate,
  Outlet,
  type RouteObject,
  useLocation,
  useNavigate,
} from 'react-router';
import { useMe } from './api.ts';
import { AcceptInvite } from './pages/AcceptInvite.tsx';
import { Admin } from './pages/Admin.tsx';
import { ListsPage } from './pages/Lists.tsx';
import { Login } from './pages/Login.tsx';
import { Home, Month } from './pages/Months.tsx';
import { Upload } from './pages/Upload.tsx';
import { Workplaces } from './pages/Workplaces.tsx';
import { ReviewLayout, ReviewNext, ReviewTicket } from './review/Review.tsx';
import { ErrorMessage, NotFound, RouteError, TicketTemplate } from './pages/simple.tsx';

function RequireAuth() {
  const me = useMe();
  const location = useLocation();
  const next = encodeURIComponent(location.pathname + location.search);
  if (me.isPending) return <Typography sx={{ m: 4 }}>Checking your login…</Typography>;
  if (me.error?.status === 401) return <Navigate to={`/login?next=${next}`} replace />;
  if (me.error) return <ErrorMessage message={me.error.message} retry={() => void me.refetch()} />;
  // `null`: the session ended while the app was open (see createQueryClient).
  if (!me.data) return <Navigate to={`/login?next=${next}&expired=1`} replace />;
  return <Outlet />;
}

function RequireAdmin() {
  const { data } = useMe();
  if (data?.role !== 'admin') return <ErrorMessage message="Only an admin can open this page." />;
  return <Outlet />;
}

function Layout() {
  const { data: me } = useMe();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [account, setAccount] = useState<HTMLElement | null>(null);
  const checking = pathname.startsWith('/review') || /^\/months\/[^/]+\/check/.test(pathname);
  // The login page logs out, so a page that asks before leaving (uploads running) can stop it.
  const logOut = () => navigate('/login', { state: { logOut: true } });
  // Design pass (T5.1, D63): one page per purpose. Workplaces opens from a month when there are
  // questions; the logins page from the account menu.
  const links = [
    ['/', 'Home'],
    ['/lists', 'Spelling lists'],
  ];
  return (
    <>
      <AppBar position="static">
        <Toolbar sx={{ gap: 1, flexWrap: 'wrap' }}>
          <Typography variant="h6" component="span" sx={{ mr: 2, fontWeight: 700 }}>
            Tally
          </Typography>
          {links.map(([to, label]) => (
            <Button
              key={to}
              color="inherit"
              component={NavLink}
              to={to!}
              end
              sx={{
                opacity: 0.8,
                borderRadius: 0,
                borderBottom: '2px solid transparent',
                '&.active': { opacity: 1, borderBottomColor: 'currentColor' },
              }}
            >
              {label}
            </Button>
          ))}
          <Box sx={{ flexGrow: 1 }} />
          <Box sx={{ display: 'flex', gap: 1, ml: 'auto', alignItems: 'center' }}>
            {/* Downloads the blank tickets straight away (Liam, D63). */}
            <Button
              variant="contained"
              href="/api/templates/v1/pdf"
              download
              sx={{
                bgcolor: 'common.white',
                color: 'primary.main',
                '&:hover': { bgcolor: '#e3e8f1' },
              }}
            >
              Print tickets
            </Button>
            <Button
              color="inherit"
              onClick={(e) => setAccount(e.currentTarget)}
              aria-haspopup="menu"
              endIcon={
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
                  <path d="M7 10l5 5 5-5z" fill="currentColor" />
                </svg>
              }
            >
              {me?.email}
            </Button>
          </Box>
          <Menu anchorEl={account} open={account !== null} onClose={() => setAccount(null)}>
            {me?.role === 'admin' && (
              <MenuItem component={Link} to="/admin" onClick={() => setAccount(null)}>
                Logins
              </MenuItem>
            )}
            <MenuItem onClick={logOut}>Log out</MenuItem>
          </Menu>
        </Toolbar>
      </AppBar>
      {/* The review screen uses the whole width: the scan needs the room (D49). */}
      <Container sx={{ py: 4 }} maxWidth={checking ? false : 'lg'}>
        <Outlet />
      </Container>
    </>
  );
}

export const routes: RouteObject[] = [
  {
    errorElement: <RouteError />,
    children: [
      { path: '/login', element: <Login /> },
      { path: '/accept-invite', element: <AcceptInvite /> },
      {
        element: <RequireAuth />,
        children: [
          {
            element: <Layout />,
            children: [
              { path: '/', element: <Home /> },
              { path: '/upload', element: <Upload /> },
              { path: '/months/:id', element: <Month /> },
              // Tickets with no date yet; a month's own tickets are checked under the month (D63).
              {
                path: '/review',
                element: <ReviewLayout />,
                children: [
                  { index: true, element: <ReviewNext /> },
                  { path: ':id', element: <ReviewTicket /> },
                ],
              },
              {
                path: '/months/:month/check',
                element: <ReviewLayout />,
                children: [
                  { index: true, element: <ReviewNext /> },
                  { path: ':id', element: <ReviewTicket /> },
                ],
              },
              { path: '/lists', element: <ListsPage /> },
              { path: '/workplaces', element: <Workplaces /> },
              { path: '/template', element: <TicketTemplate /> },
              { element: <RequireAdmin />, children: [{ path: '/admin', element: <Admin /> }] },
              { path: '*', element: <NotFound /> },
            ],
          },
        ],
      },
    ],
  },
];
