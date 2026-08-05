const mode = process.argv[2];
if (mode === "hang") {
  process.stdout.write("READY\n");
  setInterval(() => {}, 1_000);
} else {
  process.stdout.write("READY\n");
}
