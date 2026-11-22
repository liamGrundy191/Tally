// The pages and who may open them. The API checks access again on every request.
import { AppBar, Box, Button, Container, Toolbar, Typography } from '@mui/material';
import {
  NavLink,
  Navigate,
  Outlet,
  type RouteObject,
  useLocation,
  useNavigate,
} from 'react-router';
import { useMe } from './api.ts';
import { AcceptInvite } from './pages/AcceptInvite.tsx';
import { Login } from './pages/Login.tsx';
import { Home, Month } from './pages/Months.tsx';
import { Upload } from './pages/Upload.tsx';
import { ReviewLayout, ReviewNext, ReviewTicket } from './review/Review.tsx';
import {
  Admin,
  ErrorMessage,
  NotFound,
  RouteError,
  TicketTemplate,
  Workplaces,
} from './pages/simple.tsx';

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
  // The login page logs out, so a page that asks before leaving (uploads running) can stop it.
  const logOut = () => navigate('/login', { state: { logOut: true } });
  const links = [
    ['/', 'Home'],
    ['/workplaces', 'Workplaces'],
    ...(me?.role === 'admin' ? [['/admin', 'Admin']] : []),
    ['/template', 'Ticket template'],
  ];
  return (
    <>
      <AppBar position="static">
        <Toolbar sx={{ gap: 1, flexWrap: 'wrap' }}>
          <Typography variant="h6" component="span" sx={{ mr: 2 }}>
            Shift Tickets
          </Typography>
          {links.map(([to, label]) => (
            <Button key={to} color="inherit" component={NavLink} to={to!} end>
              {label}
            </Button>
          ))}
          <Box sx={{ flexGrow: 1 }} />
          <Typography variant="body2">{me?.email}</Typography>
          <Button color="inherit" onClick={logOut}>
            Log out
          </Button>
        </Toolbar>
      </AppBar>
      {/* The review screen uses the whole width: the scan needs the room (D49). */}
      <Container sx={{ py: 4 }} maxWidth={pathname.startsWith('/review') ? false : 'lg'}>
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
