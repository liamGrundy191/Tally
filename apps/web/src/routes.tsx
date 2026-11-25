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
  // The login page logs out, so a page that asks before leaving (uploads running) can stop it.
  const logOut = () => navigate('/login', { state: { logOut: true } });
  // Design pass (T5.1, D61): only what a person uses every month is in the bar; the Workplaces
  // page opens from the month when there are questions, the logins page from the account menu.
  const links = [
    ['/', 'This month'],
    ['/template', 'Print tickets'],
  ];
  return (
    <>
      <AppBar position="static">
        <Toolbar sx={{ gap: 1, flexWrap: 'wrap' }}>
          <Typography variant="h6" component="span" color="primary" sx={{ mr: 2 }}>
            Tally
          </Typography>
          {links.map(([to, label]) => (
            <Button
              key={to}
              component={NavLink}
              to={to!}
              end
              sx={{ '&.active': { bgcolor: 'action.selected' } }}
            >
              {label}
            </Button>
          ))}
          <Box sx={{ flexGrow: 1 }} />
          <Button color="inherit" onClick={(e) => setAccount(e.currentTarget)} aria-haspopup="menu">
            {me?.email}
          </Button>
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
      <Container sx={{ py: 4 }} maxWidth={pathname.startsWith('/review') ? false : 'md'}>
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
              {
                path: '/review',
                element: <ReviewLayout />,
                children: [
                  { index: true, element: <ReviewNext /> },
                  { path: ':id', element: <ReviewTicket /> },
                ],
              },
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
