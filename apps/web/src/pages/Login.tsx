import { Alert, Box, Button, Paper, TextField, Typography } from '@mui/material';
import { loginSchema } from '@tally/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';
import { api, type ApiError, safeNext, type User, useMe } from '../api.ts';

/** The narrow centred card shared by the login and invite pages. */
export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', p: 2, mt: 8 }}>
      <Paper variant="outlined" sx={{ p: 4, width: '100%', maxWidth: 400 }}>
        <Typography variant="h5" component="h1" gutterBottom>
          {title}
        </Typography>
        {children}
      </Paper>
    </Box>
  );
}

export function Login() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const navigate = useNavigate();
  const client = useQueryClient();
  const me = useMe();
  const loggingOut = (useLocation().state as { logOut?: boolean } | null)?.logOut === true;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<string>();
  const login = useMutation<User, ApiError, { email: string; password: string }>({
    mutationFn: (body) => api<User>('/api/auth/login', 'POST', body),
    onSuccess: async (user) => {
      client.clear(); // nothing cached for a previous user survives into this session
      client.setQueryData(['me'], user);
      await navigate(next, { replace: true });
    },
    onError: (e) => setProblem(e.message),
  });

  useEffect(() => {
    if (!loggingOut) return;
    void api('/api/auth/logout', 'POST')
      // Already logged out on the server (expired) or unreachable: the login page follows anyway.
      .catch(() => {})
      .then(async () => {
        // Cleared only here, off the guarded pages, which would ask the server again and bounce.
        client.clear();
        await navigate('/login', { replace: true });
      });
  }, [loggingOut, client, navigate]);

  if (loggingOut) return <Typography sx={{ m: 4 }}>Logging out…</Typography>;
  if (me.data) return <Navigate to={next} replace />;

  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = loginSchema.safeParse({ email, password });
    if (!parsed.success) return setProblem(parsed.error.issues[0]!.message);
    setProblem(undefined);
    login.mutate({ email, password });
  }

  return (
    <AuthCard title="Log in">
      {params.get('expired') && !problem && (
        <Alert severity="info" sx={{ mb: 2 }}>
          You were logged out. Please log in again.
        </Alert>
      )}
      {problem && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {problem}
        </Alert>
      )}
      <form onSubmit={submit} noValidate>
        <TextField
          label="Email"
          type="email"
          autoComplete="username"
          fullWidth
          margin="normal"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="current-password"
          fullWidth
          margin="normal"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button
          type="submit"
          variant="contained"
          fullWidth
          sx={{ mt: 2 }}
          disabled={login.isPending}
        >
          Log in
        </Button>
      </form>
    </AuthCard>
  );
}
