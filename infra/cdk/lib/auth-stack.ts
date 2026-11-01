import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import type { Construct } from "constructs";

// Cognito (COMPASS-15). The grill question for this epic is "a JWT is stolen:
// what can they do and for how long?" -- the answers are set here:
//
//   - Access tokens live 15 minutes (default is 60). That is the window a
//     stolen access token is usable, because API Gateway and the api both
//     verify signatures offline and cannot see a revocation.
//   - Refresh tokens live 1 day and ARE revocable (enableTokenRevocation):
//     sign-out or an admin global-sign-out kills the refresh token, so a thief
//     holding one stops getting new access tokens.
//   - The SPA uses the authorization-code flow with PKCE, no client secret
//     (a secret in browser JavaScript is not a secret). The implicit flow,
//     which puts tokens in the URL fragment, is not enabled.
export class AuthStack extends Stack {
  readonly userPool: cognito.UserPool;
  readonly webClient: cognito.UserPoolClient;
  readonly smokeClient: cognito.UserPoolClient;
  readonly domain: cognito.UserPoolDomain;

  constructor(
    scope: Construct,
    id: string,
    props: StackProps & { envName: string; siteUrl: string },
  ) {
    super(scope, id, props);

    this.userPool = new cognito.UserPool(this, "Users", {
      userPoolName: `compass-${props.envName}`,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      passwordPolicy: {
        minLength: 12,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: false,
        tempPasswordValidity: Duration.days(3),
      },
      // Lite tier: Plus (threat protection) bills per MAU and adds nothing a
      // portfolio demo needs. Revisit before real users.
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.domain = this.userPool.addDomain("Domain", {
      cognitoDomain: { domainPrefix: `compass-${props.envName}-${this.account}`.slice(0, 63) },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    const callbackUrls = [`${props.siteUrl}/`, "http://localhost:3000/"];

    this.webClient = this.userPool.addClient("WebClient", {
      userPoolClientName: "web",
      generateSecret: false,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true, implicitCodeGrant: false },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls,
        logoutUrls: callbackUrls,
      },
      accessTokenValidity: Duration.minutes(15),
      idTokenValidity: Duration.minutes(15),
      refreshTokenValidity: Duration.days(1),
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
    });

    new cognito.CfnManagedLoginBranding(this, "Branding", {
      userPoolId: this.userPool.userPoolId,
      clientId: this.webClient.userPoolClientId,
      useCognitoProvidedValues: true,
    });

    // For the post-deploy smoke test only (COMPASS-28): CI signs in a
    // dedicated user server-side with AdminInitiateAuth, which needs IAM
    // credentials -- so this flow is useless to anyone without the CI role.
    // Separate from the web client so the browser client never has a
    // password flow enabled at all.
    this.smokeClient = this.userPool.addClient("SmokeClient", {
      userPoolClientName: "smoke-test",
      generateSecret: false,
      authFlows: { adminUserPassword: true },
      accessTokenValidity: Duration.minutes(5),
      refreshTokenValidity: Duration.minutes(60),
      enableTokenRevocation: true,
    });
  }
}
