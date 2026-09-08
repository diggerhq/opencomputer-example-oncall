export async function handleRequest(request, state) {
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const match = new URL(request.url).pathname.match(/^\/reports\/([^/]+)$/);
  const report = match && state.reports.find((item) => item.id === decodeURIComponent(match[1]));
  if (!report) return Response.json({ error: "Report not found" }, { status: 404 });

  const timezone = (report.timezone ?? "UTC").trim();
  const generatedAt = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(report.createdAt));

  return Response.json({
    id: report.id,
    title: report.title,
    timezone,
    generatedAt,
  });
}
