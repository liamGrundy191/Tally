// Small pages and messages.
import { Alert, Box, Button, Typography } from '@mui/material';
import { AGENCY_TIME_ZONE } from '@tally/shared';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

/** A moment as its date in Israel (DD/MM/YY): when a month was closed, when an invite ends. */
export const dateInIsrael = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    timeZone: AGENCY_TIME_ZONE,
  });

export function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box sx={{ maxWidth: 720 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        {title}
      </Typography>
      {children}
    </Box>
  );
}

export function TicketTemplate() {
  return (
    <Page title="Ticket template">
      <Typography sx={{ mb: 2 }}>
        Print this page for the workers. Each A4 sheet has four tickets to cut apart.
      </Typography>
      <Button variant="contained" href="/api/templates/v1/pdf">
        Download the ticket PDF
      </Button>
    </Page>
  );
}

export function NotFound() {
  return (
    <Page title="That page does not exist.">
      <Button component={Link} to="/">
        Back to this month
      </Button>
    </Page>
  );
}

export function ErrorMessage({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <Box sx={{ m: 4, maxWidth: 720 }}>
      <Alert
        severity="error"
        action={
          retry && (
            <Button color="inherit" onClick={retry}>
              Try again
            </Button>
          )
        }
      >
        {message}
      </Alert>
    </Box>
  );
}

/** Shown instead of a page that crashed: a plain message, never the technical details. */
export function RouteError() {
  return (
    <Box sx={{ m: 4, maxWidth: 720 }}>
      <Alert
        severity="error"
        action={
          <Button color="inherit" onClick={() => window.location.reload()}>
            Reload
          </Button>
        }
      >
        Something went wrong on this page. Reload it to try again.
      </Alert>
    </Box>
  );
}
