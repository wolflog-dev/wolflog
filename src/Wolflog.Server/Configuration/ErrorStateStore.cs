namespace Wolflog.Server.Configuration;

public sealed class ErrorStateStore(IOptions<WolflogServerOptions> o, IHostEnvironment env)
    : JsonCollection<ErrorState>(o.Value.ResolveDataDirectory(env.ContentRootPath), "error-states.json")
{
    public Dictionary<string, ErrorState> Map() => All().ToDictionary(s => s.Id);

    public ErrorState Apply(string fingerprint, string? status, string? assignedTo, string? note, bool clearAssignee, string? by)
    {
        var state = Get(fingerprint) ?? new ErrorState { Id = fingerprint };
        void Log(string action) => state.History.Insert(0, new ErrorHistoryEntry { By = by, Action = action });
        if (status is ErrorStatus.Open or ErrorStatus.Resolved or ErrorStatus.Ignored && status != state.Status)
        {
            state.Status = status;
            state.ResolvedAt = status == ErrorStatus.Resolved ? DateTime.UtcNow : null;
            Log(status switch { ErrorStatus.Resolved => "a résolu l'erreur", ErrorStatus.Ignored => "a ignoré l'erreur", _ => "a rouvert l'erreur" });
        }
        if (clearAssignee && state.AssignedTo != null)
        {
            state.AssignedTo = null;
            Log("a retiré l'assignation");
        }
        else if (!string.IsNullOrWhiteSpace(assignedTo) && assignedTo != state.AssignedTo)
        {
            state.AssignedTo = assignedTo;
            Log($"a assigné l'erreur à {assignedTo}");
        }
        if (note != null && note != state.Note)
        {
            state.Note = note;
            Log("a modifié la note");
        }
        if (state.History.Count > 50) state.History.RemoveRange(50, state.History.Count - 50);
        state.UpdatedAt = DateTime.UtcNow;
        return Upsert(state);
    }
}
