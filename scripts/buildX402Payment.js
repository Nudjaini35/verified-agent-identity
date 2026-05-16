const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  parseArgs,
  hashstr,
  outputSuccess,
  outputError,
  outputInputRequired,
  getUserWallet,
  createAuthRequestMessage,
  getRequiredDidEntry,
} = require("./shared/utils");
const { getInitializedRuntime } = require("./shared/bootstrap");
const { x402Client } = require("@x402/core/client");
const { ExactEvmScheme } = require("@x402/evm/exact/client");
const {
  createHumanProofExtension,
  MissingAttestationsError,
  checkAttestation,
  isMaxUseExceededError,
} = require("@billionsnetwork/x402-human-proof-client");
const { toClientEvmSigner } = require("@x402/evm");
const {
  schemaId,
  transactionSender,
  requiredAttestationsMessage,
} = require("./shared/constants");
const { createPOUScope, createAuthScope } = require("./shared/scopes");
const { signChallenge } = require("./signChallenge");
const { v4: uuidv4 } = require("uuid");

function getPaymentHash(payment) {
  return hashstr(JSON.stringify(payment));
}

function getPaymentRequiredHash(paymentRequired) {
  return hashstr(JSON.stringify(paymentRequired));
}

function parsePaymentRequiredHeader(headerValue) {
  const trimmed = headerValue.trim();
  return trimmed.startsWith("{")
    ? JSON.parse(trimmed)
    : JSON.parse(atob(trimmed));
}

async function fetchPaymentRequired(url) {
  let response;
  try {
    response = await fetch(url);
  } catch (e) {
    outputError(`Failed to reach resource: ${e.message || e}`, true);
    return;
  }
  if (response.status !== 402) {
    outputError(`Expected 402 from ${url}, got ${response.status}`, true);
    return;
  }
  const headerValue = response.headers.get("payment-required");
  if (!headerValue) {
    outputError(
      "Resource returned 402 but no PAYMENT-REQUIRED header",
      true,
    );
    return;
  }
  try {
    return parsePaymentRequiredHeader(headerValue);
  } catch (e) {
    outputError(
      `PAYMENT-REQUIRED header is not valid JSON or Base64 JSON: ${e.message || e}`,
      true,
    );
  }
}

function persistPaymentRequired(paymentRequired) {
  const hash = getPaymentRequiredHash(paymentRequired);
  const filePath = path.join(os.tmpdir(), `${hash}.json`);
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(paymentRequired, null, 2), "utf-8");
  fs.renameSync(tempPath, filePath);
  return { hash, filePath };
}

function loadPaymentRequiredFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    outputError(
      `Failed to read --paymentRequiredFilePath ${filePath}: ${e.message || e}`,
      true,
    );
    return;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    outputError(
      `--paymentRequiredFilePath ${filePath} is not valid JSON: ${e.message || e}`,
      true,
    );
  }
}

function getRequiredAttestations(payment) {
  return (payment.extra && payment.extra.requiredAttestations) || [];
}

async function getMissingAttestations(did, payment) {
  const requiredAttestations = getRequiredAttestations(payment);
  const results = await Promise.all(
    requiredAttestations.map(async (id) => ({
      id,
      exists: await checkAttestation(did, id),
    })),
  );
  return results.filter((r) => !r.exists).map((r) => r.id);
}

async function createAttestationLinks(
  attestationSchemaIds,
  transactionSenderAddr,
  did,
  entry,
  kms,
) {
  return await Promise.all(
    attestationSchemaIds.map(async (attestationSchemaId) => {
      if (attestationSchemaId !== schemaId) {
        throw new Error(
          `Unknown attestation requirement with schema ${attestationSchemaId}`,
        );
      }
      const scope = [
        createPOUScope(transactionSenderAddr),
        createAuthScope(did),
      ];
      const signedChallenge = await signChallenge(
        { name: uuidv4(), description: uuidv4() },
        entry,
        kms,
      );
      return await createAuthRequestMessage(signedChallenge, scope);
    }),
  );
}

async function handleMissingAttestations(error, entry, kms) {
  const attestationLinks = await createAttestationLinks(
    error.attestationRequirements,
    transactionSender,
    entry.did,
    entry,
    kms,
  );
  outputInputRequired(
    {
      attestationsRequired: true,
      message: requiredAttestationsMessage,
      attestationLinks,
    },
    true,
  );
}

async function buildPaymentInfo(payment, entry, kms) {
  const requiredAttestations = getRequiredAttestations(payment);
  const missingAttestations = await getMissingAttestations(entry.did, payment);

  let attestationLinks = [];
  if (missingAttestations.length > 0) {
    attestationLinks = await createAttestationLinks(
      missingAttestations,
      transactionSender,
      entry.did,
      entry,
      kms,
    );
  }

  return {
    hash: getPaymentHash(payment),
    amount: payment.amount,
    asset: (payment.extra && payment.extra.name) || payment.asset,
    network: payment.network,
    requiredAttestations,
    hasAllAttestations: missingAttestations.length === 0,
    attestationLinks,
  };
}

async function main() {
  try {
    const args = parseArgs();

    const hasResource = Boolean(args.resource);
    const hasFilePath = Boolean(args.paymentRequiredFilePath);

    if (!hasResource && !hasFilePath) {
      outputError(
        "--resource or --paymentRequiredFilePath is required",
        true,
      );
      return;
    }
    if (hasResource && hasFilePath) {
      outputError(
        "--resource and --paymentRequiredFilePath are mutually exclusive",
        true,
      );
      return;
    }

    const { kms, memoryKeyStore, didsStorage } = await getInitializedRuntime();
    const entry = await getRequiredDidEntry(didsStorage, args.did);

    let paymentRequired;
    let paymentRequiredFilePath;

    if (hasResource) {
      paymentRequired = await fetchPaymentRequired(args.resource);
      const persisted = persistPaymentRequired(paymentRequired);
      paymentRequiredFilePath = persisted.filePath;
    } else {
      paymentRequired = loadPaymentRequiredFile(args.paymentRequiredFilePath);
      paymentRequiredFilePath = args.paymentRequiredFilePath;
    }

    const paymentResource = paymentRequired.resource;
    if (!paymentResource || !paymentResource.url) {
      outputError("paymentRequired.resource.url is required", true);
      return;
    }
    const payments = paymentRequired.accepts;

    // Phase 1: Show all payment options with their details and wait payment approval from user.
    if (hasResource && !args.paymentHash) {
      const paymentInfos = await Promise.all(
        payments.map((p) => buildPaymentInfo(p, entry, kms)),
      );
      outputInputRequired(
        {
          resource: {
            url: paymentResource.url,
            description: paymentResource.description,
          },
          payments: paymentInfos,
          paymentRequiredFilePath,
        },
        true,
      );
      return;
    }

    // Phase 2 requires --paymentHash to identify which option to execute.
    if (hasFilePath && !args.paymentHash) {
      outputError(
        "--paymentHash is required when using --paymentRequiredFilePath",
        true,
      );
      return;
    }

    // Phase 2: re-fetch the resource and verify the cached challenge still matches.
    if (hasFilePath) {
      const fresh = await fetchPaymentRequired(paymentResource.url);
      if (getPaymentRequiredHash(fresh) !== getPaymentRequiredHash(paymentRequired)) {
        outputError(
          "Cached payment-required no longer matches resource; re-run with --resource",
          true,
        );
        return;
      }
    }

    // Phase 2: User selected a payment by hash - filter to it
    if (args.paymentHash) {
      const matched = payments.find(
        (p) => getPaymentHash(p) === args.paymentHash,
      );
      if (!matched) {
        outputError("No payment matching the provided --paymentHash", true);
        return;
      }
      paymentRequired.accepts = [matched];
    }

    // Phase 3: Single payment - check attestations before proceeding
    const selectedPayment = paymentRequired.accepts[0];
    const missingAttestations = await getMissingAttestations(
      entry.did,
      selectedPayment,
    );

    if (missingAttestations.length > 0) {
      const attestationLinks = await createAttestationLinks(
        missingAttestations,
        transactionSender,
        entry.did,
        entry,
        kms,
      );
      outputInputRequired(
        {
          attestationsRequired: true,
          message: requiredAttestationsMessage,
          attestationLinks,
        },
        true,
      );
      return;
    }

    // Phase 4: Execute payment and fetch the resource
    const { wallet } = await getUserWallet(entry, memoryKeyStore);
    const signer = toClientEvmSigner(wallet);

    const x402 = new x402Client();
    x402.register("eip155:*", new ExactEvmScheme(signer));
    x402.registerExtension(
      createHumanProofExtension({
        address: wallet.address,
        pubKey: wallet.publicKey,
        signMessage: (msg) => wallet.signMessage({ message: msg }),
      }),
    );
    x402.onPaymentCreationFailure(async ({ error }) => {
      if (error instanceof MissingAttestationsError) {
        await handleMissingAttestations(error, entry, kms);
      }
    });

    let paymentPayload;
    try {
      paymentPayload = await x402.createPaymentPayload(paymentRequired);
    } catch (error) {
      if (error instanceof MissingAttestationsError) {
        return;
      } else {
        throw error;
      }
    }

    // Phase 5: Fetch the resource with the payment signature
    const paymentSignature = btoa(JSON.stringify(paymentPayload));
    const url = paymentResource.url;
    let response;
    response = await fetch(url, {
      headers: { "PAYMENT-SIGNATURE": paymentSignature },
    });

    if (response.status === 402) {
      console.log(response);
      if (isMaxUseExceededError({ response })) {
        outputInputRequired(
          {
            maxUseExceeded: true,
            message:
              "Payment has exceeded its maximum allowed uses. Choose a different payment or contact the resource provider.",
          },
          true,
        );
      }
      // if not max use exceeded, check for new payment required
      const newPaymentRequired = response.headers.get("payment-required");
      if (newPaymentRequired) {
        outputInputRequired({ newPaymentRequired: newPaymentRequired }, true);
        return;
      }
      outputError("Received 402 but no PAYMENT-REQUIRED header found", true);
      return;
    }

    const responseText = await response.text();
    let responseBody;
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      responseBody = responseText;
    }

    if (response.ok) {
      outputSuccess(responseBody, true);
    } else {
      outputError(
        `HTTP ${response.status}: ${typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody)}`,
        true,
      );
    }
  } catch (error) {
    outputError(error, true);
  }
}

main();
