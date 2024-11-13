set -euf -o pipefail

export AWS_PROFILE=restate-eng RESTATE_ENV_ID=env_201j8ncr31esdhxzkk8jzkkgffw RESTATE_API_KEY=key_10urPk2V8gxnLKo84E7RYum.EfiNa3UiVoXKXmRbGBTPhifFv6uMeRch68rKotZRLwLM
export RESTATE_ENV_URL=https://$(echo $RESTATE_ENV_ID | cut -f2 -d_).env.us.restate.cloud/Greeter/greet

npx cdk --app 'npx tsx restate-cloud.e2e.ts' synth
npx cdk --app 'npx tsx restate-cloud.e2e.ts' deploy --require-approval never --no-rollback

curl $RESTATE_ENV_URL -H "Authorization: Bearer $RESTATE_API_KEY" --json '"e2e-test"'

npx cdk --app 'npx tsx restate-cloud.e2e.ts' destroy --force
