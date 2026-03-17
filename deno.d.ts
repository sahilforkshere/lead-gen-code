// Minimal Deno type stubs so the local TypeScript language server
// doesn't report errors for Deno globals. These are provided by the
// Deno runtime at deploy time on Supabase Edge Functions.
declare namespace Deno {
  function env(): { get(key: string): string | undefined };
  namespace env {
    function get(key: string): string | undefined;
  }
}
