internal sealed record CustomerUpdate(string FirstName, string LastName, string Email, string Phone, string Password, List<Address> Addresses, Preferences Preferences);
