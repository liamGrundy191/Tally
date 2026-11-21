// The invite link is /accept-invite#token=…: a hash never reaches the server's logs or Referer.
import { Alert, Button, TextField } from '@mui/material';
import { passwordSchema } from '@tally/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { api, type ApiError, type User } from '../api.ts';
import { AuthCard } from './Login.tsx';

const BAD_LINK = 'This invite link is not valid or has expired. Ask for a new one.';

export function AcceptInvite() {
  const location = useLocation();
  const navigate = useNavigate();
  const client = useQueryClient();
  // Read once, in the initializer: an effect runs twice in development and would lose it.
  const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get('token'));
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [problem, setProblem] = useState<string>();
  const accept = useMutation<User, ApiError, string>({
    mutationFn: (pw) => api<User>('/api/auth/accept-invite', 'POST', { token, password: pw }),
    onSuccess: async (user) => {
      client.clear(); // nothing cached for a previous user survives into this session
      client.setQueryData(['me'], user);
      await navigate('/', { replace: true });
    },
    onError: (e) => setProblem(e.message),
  });

  // Take the token out of the address bar, so it is not copied, bookmarked or shared.
  useEffect(() => {
    if (location.hash) void navigate(location.pathname + location.search, { replace: true });
  }, [location, navigate]);

  if (!token) {
    return (
      <AuthCard title="Set your password">
        <Alert severity="error">{BAD_LINK}</Alert>
      </AuthCard>
    );
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = passwordSchema.safeParse(password);
    if (!parsed.success) return setProblem(parsed.error.issues[0]!.message);
    if (password !== repeat) return setProblem('The two passwords are not the same.');
    setProblem(undefined);
    accept.mutate(password);
  }

  return (
    <AuthCard title="Set your password">
      {problem && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {problem}
        </Alert>
      )}
      <form onSubmit={submit} noValidate>
        <TextField
          label="New password"
          type="password"
          autoComplete="new-password"
          helperText="At least 12 characters."
          fullWidth
          margin="normal"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />
        <TextField
          label="Type it again"
          type="password"
          autoComplete="new-password"
          fullWidth
          margin="normal"
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
        />
        <Button
          type="submit"
          variant="contained"
          fullWidth
          sx={{ mt: 2 }}
          disabled={accept.isPending}
        >
          Set password
        </Button>
      </form>
    </AuthCard>
  );
}
