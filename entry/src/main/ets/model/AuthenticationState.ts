// Port of AuthenticationMode.swift's AuthenticationState: the values typed into the auth form.

export class AuthenticationState {
  username: string = '';
  password: string = '';
  code: string = '';
}
