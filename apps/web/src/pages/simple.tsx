// Small pages and messages. Workplaces and Admin are filled in by T2.4 and T2.5.
import { Alert, Box, Button, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

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

const ComingSoon = ({ title }: { title: string }) => (
  <Page title={title}>
    <Typography color="text.secondary">This page is coming soon.</Typography>
  </Page>
);

export const Workplaces = () => <ComingSoon title="Workplaces" />;
export const Admin = () => <ComingSoon title="Admin" />;

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
        Go to Home
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
