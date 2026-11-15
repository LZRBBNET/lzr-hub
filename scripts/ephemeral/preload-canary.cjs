// Test-only fixed canary. The shell entrypoint must refuse the preload first.
process.stderr.write('EPHEMERAL_PRELOAD_EXECUTED\n');
process.exit(79);
