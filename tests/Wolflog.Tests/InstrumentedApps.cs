namespace Wolflog.Tests;

/// <summary>
/// Tests qui démarrent une application instrumentée dans le processus des tests : ses écouteurs (requêtes reçues, exceptions
/// non observées, échantillonnage du processeur) captent aussi ce que font les autres serveurs de test en parallèle.
/// Ils s'exécutent donc seuls, l'un après l'autre, après les autres tests.
/// </summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class InstrumentedApps
{
    public const string Name = "Applications instrumentées";
}
