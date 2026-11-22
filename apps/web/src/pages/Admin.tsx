// The Admin page (section 9): the accounts, and inviting someone. The API checks every change
// again (admin only, always one active admin); this page only hides changes to your own account.
import {
  Alert,
  Box,
  Button,
  FormControlLabel,
  FormLabel,
  Radio,
  RadioGroup,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { AGENCY_TIME_ZONE, emailSchema, type Role } from '@tally/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { api, type Account, type ApiError, useMe } from '../api.ts';
import { ConfirmDialog } from '../review/Review.tsx';
import { Page } from './simple.tsx';

type Change = { user: Account; body: { role?: Role; disabled?: boolean } };

/** What the dialog asks before a change; Enable needs no question. */
function question({ user, body }: Change) {
  if (body.disabled)
    return {
      text: `Disable ${user.email}? They are logged out at once and cannot log in until an admin enables them again.`,
      confirm: 'Disable',
    };
  if (body.role === 'admin')
    return {
      text: `Make ${user.email} an admin? They will be able to invite people and change accounts. They see the Admin page the next time they open the site.`,
      confirm: 'Make admin',
    };
  return {
    text: `Make ${user.email} a reviewer? They will no longer see the Admin page.`,
    confirm: 'Make reviewer',
  };
}

const until = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    timeZone: AGENCY_TIME_ZONE,
  });

export function Admin() {
  const me = useMe().data;
  const client = useQueryClient();
  // A 403 means this person is no longer an admin: ask again who they are, and the menu follows.
  const refused = (e: ApiError) => {
    if (e.status === 403) void client.invalidateQueries({ queryKey: ['me'] });
  };
  const users = useQuery<Account[], ApiError>({
    queryKey: ['users'],
    queryFn: () => api('/api/users'),
  });
  useEffect(() => {
    if (users.error) refused(users.error);
  }, [users.error]);
  // What the dialog asks about; kept while it closes, so its text does not go blank.
  const [asking, setAsking] = useState<Change | null>(null);
  const [sure, setSure] = useState(false);
  const change = useMutation<Account, ApiError, Change>({
    mutationFn: (c) => api(`/api/users/${c.user.id}`, 'PATCH', c.body),
    onError: refused,
    onSettled: () => {
      setSure(false);
      void client.invalidateQueries({ queryKey: ['users'] });
    },
  });

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('reviewer');
  const [problem, setProblem] = useState<string>();
  const [copied, setCopied] = useState<string>();
  // The link lives only in this mutation's answer: never stored, logged or put in an address.
  const invite = useMutation<
    { inviteUrl: string; expiresAt: string },
    ApiError,
    { email: string; role: Role }
  >({
    mutationFn: (b) => api('/api/users/invite', 'POST', b),
    gcTime: 0, // the link is not kept in the cache once the page is left
    onSuccess: () => {
      setEmail('');
      setCopied(undefined);
    },
    onError: (e) => {
      setProblem(e.message);
      refused(e);
    },
  });
  const busy = change.isPending || invite.isPending;

  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) return setProblem(parsed.error.issues[0]!.message);
    setProblem(undefined);
    invite.mutate({ email: parsed.data, role });
  }

  async function copy(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied('Copied.');
    } catch {
      setCopied('Could not copy. Select the link and copy it yourself.');
    }
  }

  const ask = (c: Change) => {
    setAsking(c);
    setSure(true);
  };

  return (
    <Page title="Admin">
      <Typography variant="h5" component="h2" gutterBottom>
        Accounts
      </Typography>
      {change.error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {change.error.message}
        </Alert>
      )}
      {users.error ? (
        <Alert
          severity="error"
          action={
            <Button color="inherit" onClick={() => void users.refetch()}>
              Try again
            </Button>
          }
        >
          {users.error.message}
        </Alert>
      ) : !users.data ? (
        <Typography>Loading the accounts…</Typography>
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Email</TableCell>
              <TableCell>Role</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Change</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {/* Your own account first, then by email (the server's order). */}
            {[
              ...users.data.filter((u) => u.id === me?.id),
              ...users.data.filter((u) => u.id !== me?.id),
            ].map((u) => (
              <TableRow key={u.id}>
                <TableCell>{u.email}</TableCell>
                <TableCell>{u.role === 'admin' ? 'Admin' : 'Reviewer'}</TableCell>
                <TableCell>{u.disabledAt ? 'Disabled' : 'Active'}</TableCell>
                <TableCell>
                  {u.id === me?.id ? (
                    'This is you.'
                  ) : (
                    <Stack direction="row" spacing={1}>
                      <Button
                        size="small"
                        disabled={busy}
                        onClick={() =>
                          ask({
                            user: u,
                            body: { role: u.role === 'admin' ? 'reviewer' : 'admin' },
                          })
                        }
                      >
                        {u.role === 'admin' ? 'Make reviewer' : 'Make admin'}
                      </Button>
                      {u.disabledAt ? (
                        <Button
                          size="small"
                          disabled={busy}
                          onClick={() => change.mutate({ user: u, body: { disabled: false } })}
                        >
                          Enable
                        </Button>
                      ) : (
                        <Button
                          size="small"
                          disabled={busy}
                          onClick={() => ask({ user: u, body: { disabled: true } })}
                        >
                          Disable
                        </Button>
                      )}
                    </Stack>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Typography variant="h5" component="h2" gutterBottom sx={{ mt: 4 }}>
        Invite someone
      </Typography>
      <Typography sx={{ mb: 1 }}>
        You get a link to send them yourself. With it they set their own password.
      </Typography>
      {problem && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {problem}
        </Alert>
      )}
      <Box component="form" onSubmit={submit} noValidate>
        <TextField
          label="Email"
          type="email"
          fullWidth
          margin="normal"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <FormLabel id="invite-role">Role</FormLabel>
        <RadioGroup
          row
          aria-labelledby="invite-role"
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
        >
          <FormControlLabel value="reviewer" control={<Radio />} label="Reviewer" />
          <FormControlLabel value="admin" control={<Radio />} label="Admin" />
        </RadioGroup>
        <Button type="submit" variant="contained" sx={{ mt: 1 }} disabled={busy}>
          Invite
        </Button>
      </Box>
      {invite.data && (
        <Alert severity="success" sx={{ mt: 2 }}>
          <Typography sx={{ mb: 1 }}>
            Send this link to {invite.variables.email}. It works once, until{' '}
            {until(invite.data.expiresAt)}. It will not be shown again. Any earlier link for this
            email no longer works.
          </Typography>
          <Typography sx={{ mb: 1 }}>
            <strong>
              Do not open this link yourself: whoever opens it first gets the account.
            </strong>
          </Typography>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <TextField
              label="Invite link"
              size="small"
              fullWidth
              value={invite.data.inviteUrl}
              slotProps={{ htmlInput: { readOnly: true } }}
              onFocus={(e) => e.target.select()}
            />
            <Button variant="outlined" onClick={() => void copy(invite.data.inviteUrl)}>
              Copy
            </Button>
          </Stack>
          {copied && <Typography sx={{ mt: 1 }}>{copied}</Typography>}
        </Alert>
      )}
      <ConfirmDialog
        open={sure}
        title="Are you sure?"
        text={asking && question(asking).text}
        confirm={asking ? question(asking).confirm : ''}
        busy={change.isPending}
        onConfirm={() => change.mutate(asking!)}
        onClose={() => setSure(false)}
      />
    </Page>
  );
}
