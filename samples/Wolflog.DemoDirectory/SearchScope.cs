namespace Wolflog.DemoDirectory;

/// <summary>Portée d'une recherche LDAP (RFC 4511) : l'entrée de base, ses enfants directs, ou tout le sous-arbre.</summary>
public enum SearchScope
{
    BaseObject = 0,
    SingleLevel = 1,
    WholeSubtree = 2,
}
