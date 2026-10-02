namespace Wolflog.DemoDirectory;

/// <summary>Codes de résultat LDAP (RFC 4511) utilisés par l'annuaire de démonstration.</summary>
public enum LdapResultCode
{
    Success = 0,
    OperationsError = 1,
    ProtocolError = 2,
    SizeLimitExceeded = 4,
    AuthMethodNotSupported = 7,
    NoSuchObject = 32,
    InvalidCredentials = 49,
    UnwillingToPerform = 53,
}
