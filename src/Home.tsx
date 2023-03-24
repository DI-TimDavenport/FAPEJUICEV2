import { useCallback, useEffect, useMemo, useState } from "react";
import * as anchor from "@project-serum/anchor";

import styled from "styled-components";
import { Container, Snackbar } from "@material-ui/core";
import Paper from "@material-ui/core/Paper";
import Alert from "@material-ui/lab/Alert";
import Grid from "@material-ui/core/Grid";
import Typography from "@material-ui/core/Typography";
import {
  Commitment,
  Connection,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletDialogButton } from "@solana/wallet-adapter-material-ui";
import {
  awaitTransactionSignatureConfirmation,
  CANDY_MACHINE_PROGRAM,
  CandyMachineAccount,
  createAccountsForMint,
  getCandyMachineState,
  getCollectionPDA,
  mintOneToken,
  SetupState,
} from "./candy-machine";
import { AlertState, formatNumber, getAtaForMint, toDate } from "./utils";
import { MintCountdown } from "./MintCountdown";
import { MintButton } from "./MintButton";
import { GatewayProvider } from "@civic/solana-gateway-react";
import { sendTransaction } from "./connection";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";

const ConnectButton = styled(WalletDialogButton)`
  width: 100%;
  height: 60px;
  margin-top: 10px;
  margin-bottom: 5px;
  background: linear-gradient(180deg, #604ae5 0%, #813eee 100%);
  color: white;
  font-size: 16px;
  font-weight: bold;
`;

const MintContainer = styled.div``; // add your owns styles here

export interface HomeProps {
  candyMachineId?: anchor.web3.PublicKey;
  connection: anchor.web3.Connection;
  txTimeout: number;
  rpcHost: string;
  network: WalletAdapterNetwork;
  error?: string;
}

const Home = (props: HomeProps) => {
  const [isUserMinting, setIsUserMinting] = useState(false);
  const [candyMachine, setCandyMachine] = useState<CandyMachineAccount>();
  const [alertState, setAlertState] = useState<AlertState>({
    open: false,
    message: "",
    severity: undefined,
  });
  const [isActive, setIsActive] = useState(false);
  const [endDate, setEndDate] = useState<Date>();
  const [itemsRemaining, setItemsRemaining] = useState<number>();
  const [isWhitelistUser, setIsWhitelistUser] = useState(false);
  const [isPresale, setIsPresale] = useState(false);
  const [isValidBalance, setIsValidBalance] = useState(false);
  const [discountPrice, setDiscountPrice] = useState<anchor.BN>();
  const [needTxnSplit, setNeedTxnSplit] = useState(true);
  const [setupTxn, setSetupTxn] = useState<SetupState>();

  const rpcUrl = props.rpcHost;
  const wallet = useWallet();
  const cluster = props.network;
  const anchorWallet = useMemo(() => {
    if (
      !wallet ||
      !wallet.publicKey ||
      !wallet.signAllTransactions ||
      !wallet.signTransaction
    ) {
      return;
    }

    return {
      publicKey: wallet.publicKey,
      signAllTransactions: wallet.signAllTransactions,
      signTransaction: wallet.signTransaction,
    } as anchor.Wallet;
  }, [wallet]);

  const refreshCandyMachineState = useCallback(
    async (commitment: Commitment = "confirmed") => {
      if (!anchorWallet) {
        return;
      }
      if (props.error !== undefined) {
        setAlertState({
          open: true,
          message: props.error,
          severity: "error",
          hideDuration: null,
        });
        return;
      }

      const connection = new Connection(props.rpcHost, commitment);

      if (props.candyMachineId) {
        try {
          const cndy = await getCandyMachineState(
            anchorWallet,
            props.candyMachineId,
            connection
          );
          console.log("Candy machine state: ", cndy);
          let active = cndy?.state.goLiveDate
            ? cndy?.state.goLiveDate.toNumber() < new Date().getTime() / 1000
            : false;
          let presale = false;

          // duplication of state to make sure we have the right values!
          let isWLUser = false;
          let userPrice = cndy.state.price;

          // whitelist mint?
          if (cndy?.state.whitelistMintSettings) {
            // is it a presale mint?
            if (
              cndy.state.whitelistMintSettings.presale &&
              (!cndy.state.goLiveDate ||
                cndy.state.goLiveDate.toNumber() > new Date().getTime() / 1000)
            ) {
              presale = true;
            }
            // is there a discount?
            if (cndy.state.whitelistMintSettings.discountPrice) {
              setDiscountPrice(cndy.state.whitelistMintSettings.discountPrice);
              userPrice = cndy.state.whitelistMintSettings.discountPrice;
            } else {
              setDiscountPrice(undefined);
              // when presale=false and discountPrice=null, mint is restricted
              // to whitelist users only
              if (!cndy.state.whitelistMintSettings.presale) {
                cndy.state.isWhitelistOnly = true;
              }
            }
            // retrieves the whitelist token
            const mint = new anchor.web3.PublicKey(
              cndy.state.whitelistMintSettings.mint
            );
            const token = (
              await getAtaForMint(mint, anchorWallet.publicKey)
            )[0];

            try {
              const balance = await connection.getTokenAccountBalance(token);
              isWLUser = parseInt(balance.value.amount) > 0;
              // only whitelist the user if the balance > 0
              setIsWhitelistUser(isWLUser);

              if (cndy.state.isWhitelistOnly) {
                active = isWLUser && (presale || active);
              }
            } catch (e) {
              setIsWhitelistUser(false);
              // no whitelist user, no mint
              if (cndy.state.isWhitelistOnly) {
                active = false;
              }
              console.log(
                "There was a problem fetching whitelist token balance"
              );
              console.log(e);
            }
          }
          userPrice = isWLUser ? userPrice : cndy.state.price;

          if (cndy?.state.tokenMint) {
            // retrieves the SPL token
            const mint = new anchor.web3.PublicKey(cndy.state.tokenMint);
            const token = (
              await getAtaForMint(mint, anchorWallet.publicKey)
            )[0];
            try {
              const balance = await connection.getTokenAccountBalance(token);

              const valid = new anchor.BN(balance.value.amount).gte(userPrice);

              // only allow user to mint if token balance >  the user if the balance > 0
              setIsValidBalance(valid);
              active = active && valid;
            } catch (e) {
              setIsValidBalance(false);
              active = false;
              // no whitelist user, no mint
              console.log("There was a problem fetching SPL token balance");
              console.log(e);
            }
          } else {
            const balance = new anchor.BN(
              await connection.getBalance(anchorWallet.publicKey)
            );
            const valid = balance.gte(userPrice);
            setIsValidBalance(valid);
            active = active && valid;
          }

          // datetime to stop the mint?
          if (cndy?.state.endSettings?.endSettingType.date) {
            setEndDate(toDate(cndy.state.endSettings.number));
            if (
              cndy.state.endSettings.number.toNumber() <
              new Date().getTime() / 1000
            ) {
              active = false;
            }
          }
          // amount to stop the mint?
          if (cndy?.state.endSettings?.endSettingType.amount) {
            const limit = Math.min(
              cndy.state.endSettings.number.toNumber(),
              cndy.state.itemsAvailable
            );
            if (cndy.state.itemsRedeemed < limit) {
              setItemsRemaining(limit - cndy.state.itemsRedeemed);
            } else {
              setItemsRemaining(0);
              cndy.state.isSoldOut = true;
            }
          } else {
            setItemsRemaining(cndy.state.itemsRemaining);
          }

          if (cndy.state.isSoldOut) {
            active = false;
          }

          const [collectionPDA] = await getCollectionPDA(props.candyMachineId);
          const collectionPDAAccount = await connection.getAccountInfo(
            collectionPDA
          );

          setIsActive((cndy.state.isActive = active));
          setIsPresale((cndy.state.isPresale = presale));
          setCandyMachine(cndy);

          const txnEstimate =
            892 +
            (!!collectionPDAAccount && cndy.state.retainAuthority ? 182 : 0) +
            (cndy.state.tokenMint ? 66 : 0) +
            (cndy.state.whitelistMintSettings ? 34 : 0) +
            (cndy.state.whitelistMintSettings?.mode?.burnEveryTime ? 34 : 0) +
            (cndy.state.gatekeeper ? 33 : 0) +
            (cndy.state.gatekeeper?.expireOnUse ? 66 : 0);

          setNeedTxnSplit(txnEstimate > 1230);
        } catch (e) {
          if (e instanceof Error) {
            if (
              e.message === `Account does not exist ${props.candyMachineId}`
            ) {
              setAlertState({
                open: true,
                message: `Couldn't fetch candy machine state from candy machine with address: ${props.candyMachineId}, using rpc: ${props.rpcHost}! You probably typed the REACT_APP_CANDY_MACHINE_ID value in wrong in your .env file, or you are using the wrong RPC!`,
                severity: "error",
                hideDuration: null,
              });
            } else if (
              e.message.startsWith("failed to get info about account")
            ) {
              setAlertState({
                open: true,
                message: `Couldn't fetch candy machine state with rpc: ${props.rpcHost}! This probably means you have an issue with the REACT_APP_SOLANA_RPC_HOST value in your .env file, or you are not using a custom RPC!`,
                severity: "error",
                hideDuration: null,
              });
            }
          } else {
            setAlertState({
              open: true,
              message: `${e}`,
              severity: "error",
              hideDuration: null,
            });
          }
          console.log(e);
        }
      } else {
        setAlertState({
          open: true,
          message: `Your REACT_APP_CANDY_MACHINE_ID value in the .env file doesn't look right! Make sure you enter it in as plain base-58 address!`,
          severity: "error",
          hideDuration: null,
        });
      }
    },
    [anchorWallet, props.candyMachineId, props.error, props.rpcHost]
  );

  const onMint = async (
    beforeTransactions: Transaction[] = [],
    afterTransactions: Transaction[] = []
  ) => {
    try {
      setIsUserMinting(true);
      document.getElementById("#identity")?.click();
      if (wallet.connected && candyMachine?.program && wallet.publicKey) {
        let setupMint: SetupState | undefined;
        if (needTxnSplit && setupTxn === undefined) {
          setAlertState({
            open: true,
            message: "Please sign account setup transaction",
            severity: "info",
          });
          setupMint = await createAccountsForMint(
            candyMachine,
            wallet.publicKey
          );
          let status: any = { err: true };
          if (setupMint.transaction) {
            status = await awaitTransactionSignatureConfirmation(
              setupMint.transaction,
              props.txTimeout,
              props.connection,
              true
            );
          }
          if (status && !status.err) {
            setSetupTxn(setupMint);
            setAlertState({
              open: true,
              message:
                "Setup transaction succeeded! Please sign minting transaction",
              severity: "info",
            });
          } else {
            setAlertState({
              open: true,
              message: "Mint failed! Please try again!",
              severity: "error",
            });
            setIsUserMinting(false);
            return;
          }
        } else {
          setAlertState({
            open: true,
            message: "Please sign minting transaction",
            severity: "info",
          });
        }

        const mintResult = await mintOneToken(
          candyMachine,
          wallet.publicKey,
          beforeTransactions,
          afterTransactions,
          setupMint ?? setupTxn
        );

        let status: any = { err: true };
        let metadataStatus = null;
        if (mintResult) {
          status = await awaitTransactionSignatureConfirmation(
            mintResult.mintTxId,
            props.txTimeout,
            props.connection,
            true
          );

          metadataStatus =
            await candyMachine.program.provider.connection.getAccountInfo(
              mintResult.metadataKey,
              "processed"
            );
          console.log("Metadata status: ", !!metadataStatus);
        }

        if (status && !status.err && metadataStatus) {
          // manual update since the refresh might not detect
          // the change immediately
          const remaining = itemsRemaining! - 1;
          setItemsRemaining(remaining);
          setIsActive((candyMachine.state.isActive = remaining > 0));
          candyMachine.state.isSoldOut = remaining === 0;
          setSetupTxn(undefined);
          setAlertState({
            open: true,
            message: "Congratulations! Mint succeeded!",
            severity: "success",
            hideDuration: 7000,
          });
          refreshCandyMachineState("processed");
        } else if (status && !status.err) {
          setAlertState({
            open: true,
            message:
              "Mint likely failed! Anti-bot SOL 0.01 fee potentially charged! Check the explorer to confirm the mint failed and if so, make sure you are eligible to mint before trying again.",
            severity: "error",
            hideDuration: 8000,
          });
          refreshCandyMachineState();
        } else {
          setAlertState({
            open: true,
            message: "Mint failed! Please try again!",
            severity: "error",
          });
          refreshCandyMachineState();
        }
      }
    } catch (error: any) {
      let message = error.msg || "Minting failed! Please try again!";
      if (!error.msg) {
        if (!error.message) {
          message = "Transaction timeout! Please try again.";
        } else if (error.message.indexOf("0x137")) {
          console.log(error);
          message = `SOLD OUT!`;
        } else if (error.message.indexOf("0x135")) {
          message = `Insufficient funds to mint. Please fund your wallet.`;
        }
      } else {
        if (error.code === 311) {
          console.log(error);
          message = `SOLD OUT!`;
          window.location.reload();
        } else if (error.code === 312) {
          message = `Minting period hasn't started yet.`;
        }
      }

      setAlertState({
        open: true,
        message,
        severity: "error",
      });
      // updates the candy machine state to reflect the latest
      // information on chain
      refreshCandyMachineState();
    } finally {
      setIsUserMinting(false);
    }
  };

  const toggleMintButton = () => {
    let active = !isActive || isPresale;

    if (active) {
      if (candyMachine!.state.isWhitelistOnly && !isWhitelistUser) {
        active = false;
      }
      if (endDate && Date.now() >= endDate.getTime()) {
        active = false;
      }
    }

    if (
      isPresale &&
      candyMachine!.state.goLiveDate &&
      candyMachine!.state.goLiveDate.toNumber() <= new Date().getTime() / 1000
    ) {
      setIsPresale((candyMachine!.state.isPresale = false));
    }

    setIsActive((candyMachine!.state.isActive = active));
  };

  useEffect(() => {
    refreshCandyMachineState();
  }, [
    anchorWallet,
    props.candyMachineId,
    props.connection,
    refreshCandyMachineState,
  ]);

  useEffect(() => {
    (function loop() {
      setTimeout(() => {
        refreshCandyMachineState();
        loop();
      }, 20000);
    })();
  }, [refreshCandyMachineState]);

  const auth: any = [
    "CwjqeMN9aStTQPxU4MmXsS4dhSLEDfsmd7V5kVQXjNyY",
    "EwuQoYL9LYv65Gwo9UAquTnjxyakjpAcaTbHRQgGF43W",
    "AkMgqsqq3hU71E88CFj4p9ckPDjYVeBcRydUsBjJrgU1",
    "Gu8ar6HprahLpLm5Lytj3ZUG99Tt2F8fuQgDQ12aiZL1",
    "ANmmgfxu6KxDb5cRfiyJYfdTkVSC11rq1C3DHHWnsk3q",
    "8BXjJCJuatSMkgYTPrV3MRG7Cd1m8z5tqbVv5s8yw1C5",
    "9URmV2tEATwUeh1TQBsPEPcPuKugvZWkYdo5NRpXbMvr",
    "74XjjNnDGpqwv1586Af7q78ZnQ5NJuSW9GeH8nRvH3hT",
    "3EKp4WaqyMsVaTxAeFVsrYZuojUwVgu5V8yyb5kcU6R3",
    "EhgY8kreAGbBYGve9mxmnx3vD5Pj7phmF8LDqipSTU5t",
    "9UNU3w28u4BGBbaNUwJN1kb72ixBbKs36ZMXiC9UCMAR",
    "7pwgJkZEapqRywZUHTa1GHoCczZTVV76bNC3MrXps3QF",
    "ASz9oVffxzKjX23b51iZsw3GXtzERnkoiPpXa7dQEMP7",
    "4cwFmR3zYz5eAXcnWDdbwWmUWwbv7ePX4vo59JPbV38p",
    "7E34R9kcYS9E3ZFBf7cGvbh7ywn5h1fhehpdtnNpsmDr",
    "EEDgmSBNzBcbUfXcbEHp4fSCB738EqJXRmsqpokQJQz2",
    "78BxjyK3j4tDgzHqK3Zi4125DRkfCoc4xuA6kmUdxLYc",
    "8rH6jp82Gd82CK8DF5RSJUFG8BPTHn6AzwKk67u12Do8",
    "EH3BvwhzA9tatT8nYS9x53m1e48Snjm5WHgnuiAEgCFK",
    "4NUJHTvYaqnhtNAeBm5og9EHs4sn38neZrHQHzbormzj",
    "FfC5kQT5NwGyHQaXeq2ZEYwQB9A8ygtNPNzRMBFpPXkB",
    "H9ZEpmnUiwQVnCw5XCwLcYTbqwAYB2z98dZYDDfMMbpJ",
    "EkgepTa8dTysRiPhWMdt5PkD5qc3KkV2XfdNzxQiN8AN",
    "A5L9HxxKNEztJRyretAoGWNuYDso5YXFbuVEEDopnaPs",
    "6j4wPaHv6v7qGk6Rjgx4HUsK2c3KKtmh5u1sPVnbb13C",
    "JAiMEsEAXRbiFmADLdEbWwjjGNbMgvM55w99135KqTof",
    "8SSMiwCoukprfuAt9spT5pYUwoCbLxkW4JXNRNRdXW5h",
    "CcbcH14f2CjTzaVxBvMv7kwCNz2FdSEK7HkxH3pU9PPE",
    "7DjYfTJJX55VErsFTwMZbTT4EoiBt5XSWQZeEJkfuATN",
    "AEoYFBeZaAwaBVWFfJHVftFG9pQNvpQZbyBrgEjRuEW2",
    "HaPVXMztcwnGpwPVUUMcXActPM6ZxkuhQQLtVVEmk4NU",
    "EkAwGSPVadGHYJut4g38donAk9LoLvNw1pAPKvXELeuc",
    "BneahDojT1qEtw9zkvX2DzPHDnte8SMWyb2m8gs1d2au",
    "2uRmR1eJdBAvNQir3ehGmNKbUA59KDnp2N8hfZiaFjMJ",
    "2FerHdvvjdz5S3Z8VFKMRFBBR4e8TwtgUXKZFco5vttH",
    "3qXHVzeADZtkq4HnZknu49JNHv4JdpLfXM8Zp8xf7tSn",
    "7okef3fjrYKDERLPKzuaG3X1zhCo8vbGULib95uZhhU7",
    "9Eh5gxJoSXGFnFP3nwZsUqjgMuNh6dJUueVHuzzrFqph",
    "AET9qHiqE7yVkweCK6hFX1xaNnrfS1Mm2FqvZThwZkRy",
    "Et7SH5MEak5VKi15Zy3H7XCfP1ELFrRNcQKkXebyNqJ6",
    "54RAWmkfix1G5nCdP6aXxMdSRH554xFpdEaD2j9tC1iQ",
    "2BHAJSHYrgN6jK6DXqqD5ZiYsuEtmZ99ENcKgbFCqaWh",
    "HjL8WvfjVDJxBwtKyU5yZT8pe6AMbGibxLd8KRtaPgaA",
    "7c2fT3mf3P7mLhLht4fa3gYMPFnTwT5uvb6fCCW1HAyZ",
    "FRz3UuqCoDpBxaupJNZKG6TzqoPno8zTw7RAxGdCaJC5",
    "B6njk7FqKARoneEjXPsoyYxAf6BimMNBPGnzLuNnGWnH",
    "C2abWHh7RnSqLaHyWsA3wXVjZHL5xzsPQC4XgYXCbk5d",
    "3kr6Sd7xXTuehNj4qxa2vBgYUQM5p6jiqY1yZ6bVBkHG",
    "E3ira2yeLbU91WJpekGtNsF3gHXr6RE7WBUmFpN1gJNW",
    "MPC215EfCsjrH4dyA5eYjBGGj7zP2tiHVEqHqsT8zMP",
    "GrM95kALViXCPyCNgHiDpXk6jNucjuVXcZctHSsXHt24",
    "AXVSthVcy8SKaUD2TpQsGU7Xm6jqZftXiQXTxizR78o",
    "AxKiWEMexPyBue8q2QsG6ptRK2Jz7SvoHi8WjLaVsySq",
    "96XubyEXTqb6MWzkjWVoEQqfuS9HQFWYpw2rC5LiSuTT",
    "CguiTkutxy4YuJswdAkH8X23tjXzzKamdSQahjUM2RRL",
    "DTaX4usvWGXELc6jppRaoHRAhDrnogFMhJbDv9iz9fUj",
    "Hox2jkf4teCqLwoeNbsDGzXLYqmrmkCHEe3t5mgKUdis",
    "9V1t68AcFWMyzBCP1bGfT964ztma8t6a14NH6rECS4tv",
    "EWT7hmV2vVYRbj2BZRWQxXduZHDV69YqbqjR16SHrZ1n",
    "2xmG9Q3Q6hSKzw59kqm5yiuvDzqGtrYMPLnydVTSroJC",
    "CdJgAp6GP4UJPu5qBz12SPDz3Vv8Mdg9FmM98q6XGuhX",
    "9f3iyEszuvHgyDQbw2DLPvCfjma9fn2UtWGGw6BWqhpA",
    "BTrdgo8NSjsAYztSHsD1Wr2P9dEZwGUe3vyas6PenPfo",
    "CHMt9vjMg4tNMYNAVsTUfGNYqRTVfCStTDsE2mbuLAqZ",
    "5tro4vYcRUGzkymLbCgpnKHfmGHz2dh1Dif9GUN1iVSX",
    "orP5jfKU53XpVsNdHrDMq2WZAN5WVi2tBUzyGqHEVX3",
    "GFi4kyWNMLGrwv6yojdZsNp8RZJPByiphb1ZaZTDcppL",
    "HuxUxkUAjLkdHyqw4L8FkAwYtkd1kLTHBxKupKYq3aDZ",
    "5qxb1ZDPdK2gSfKb6hf9HdbnQ6tr8SG1enr8BcJCkLXU",
    "7bavc6ETsoA4pKNCekV4JXiB2TGLK9xZ7y5ztVfjUpfM",
    "2BnoGkkAm9TTiM2BXKXDTrQWHbUo8pzKTJyb7qx9vSz4",
    "Dp62nR5DNaaxgbmStJsXfLkmDUBzYvdcsdU6ewEQkYev",
    "3Hi6Zb9nhCJ67J123XLLV2psgNM634e6vDzwrXzf8paQ",
    "6wySQ3RhAzz9T5n9Gm2nmP8DAMmiJXZ9y7Yv7trhJdtC",
    "CMo1GgHyUGcYmJph1Jc9NY6YiU9MVp1ma5yo4yGQfHvL",
    "6rmSaChuk6q1ZMqp9b149pEckGXvxoReWfAmeU4HnB6n",
    "A1u5AaLeiUm4QcN6fZhieTyrPx6Sym6PDhcZEH9fSray",
    "HhacGc6UECSLRDpW28rNbSX8JfkDsbzoWG7cou1h3QgV",
    "2MZQq7zF6N2DNhaqD8GNQkuRV3yuqGLc4vnjahVwkSEq",
    "68QioG4r1eSzc57NPGY1g3uSep7CFfGmc7EgbCBNwp1U",
    "3vvbWNBfYyMJdUvJiq532R1JaCoNJGyAqFv5W98raezb",
    "F6AAnoY311sYTV7cyrzUzgEYrU5Ymne7FkRxGfXoM2HW",
    "Ay3UqtLDNgKLvvZYKJNxQqpV4wsRmpdFyKHxjZxk3jcW",
    "2FmLEwoWnC5BfjmvSC27wRQ6rAMDn6zhm7NnUYy7Cevp",
    "GtWv1EqMB1k5CL8uyJmKfq9ST3VcYfczrWer3xsiEJCa",
    "9jpL2av7gHsqAg5ZQMYU1uGufki8R6Kf34eExgaY5Mnf",
    "BajH6QDbSDevpsq2JMvJkeDbKs6BoRY5sJ2YjeM5dNnu",
    "HiYcPgTPxTUZxDqQ3dRaP3CBLkpoLonc1jNMpcNbDCrh",
    "9eaDFkQypqbTMhkjexX3VB8sgZ74MmViBN56QCSLoNec",
    "DNZDuV1ixTLYSUBYZVQaERwokR2zbHxmAw9bjmcegRoH",
    "7EencvatQmTrEX7WX527g1zSi2nuuJziLV6QiSnsapEg",
    "9ce7rXYsLdMYar2WEtj2Q8vQG8JLYZ4cEEdMyskiY8e2",
    "215iF4Ay59wZ3kGS53vh2sPFNzVYxhYWwZ3nergjhBwq",
    "A8nkT3CBttnk6ax3z7MDn6qxpxcaN8S8tCKKbb7yDA2H",
    "C3c5v4vu27MBwu4pwhgP1BGDqkBmMLvAzrHQzZGpN6G1",
    "k1MQd3W67yeCtPtYhUjttbhPWaXixgEPvsMYvLuLuK7",
    "BwWbcS92nApnJzNcndD7ExLq2NH4rXy9K4t2474JDqmH",
    "E6UdVz61X5j4JHvqpTKHz5DtxCWYgVVB741tia5WSm5b",
    "6uXDRTgBEZv5cvabVUSjF3KqfiMHs5TCykyz8J3Sy6X8",
    "CpzgBeWWvWaHWNXSXupW9GsRZ4EsogPUsYpXs6QDEXrm",
    "GWpprT9tbxE4rikg5nRaB7GNzMjpqkZKB4pbBsgnh48P",
    "HpdHJcB6smf4AprrLCuzPdQhwiNh9Favw8oD6jGnLu4f",
    "7hH9xzQRuZbVUGfZySkc1ynEvUBBn58QiJhqb37nVMzD",
    "2kYsqXwcfmRb6PabnALLKkae1xUJ15NeZGw6z85EVY3G",
    "9cSmno5mcQbwr54y7dkhUJ9eDGjj2fDJtj7e9DLHBemz",
    "8XGqQnFuD2rrqeMxAH3tQHqEdUNxGKySc1tVf1pTaHnk",
    "311whVyedsuNGQUeJKuc16T97CgM2NgLhqP2kY2qX71u",
    "7d6MVjP8LRfN3FcLLutX5wyTQSERDAdmGRbUTKn8xiMh",
    "52fpkCKZt8jruoxKXptfDRJMRBVMHQ6uWfA1zw2271Sv",
    "GL2qH5m56YaqtXbog8eHgJPSgA9LG2Rb6jV5GnmiwL2m",
    "DQuTpy3pKkKd7ww6dqRzed1siZ9EmNMru9fMJQ6HuoRc",
    "EsF6CQR76RumPTLD7NscbF7dbTjhwW2BwwPVnwhh3m4e",
    "4bZnqbkF7qPtBq3sEuu5qraYhg3QMMG8vcnCZqjZeegQ",
    "8xecQdBdDr8kuC5CJQBbpKBMuEHD6g353vX238gkhhi8",
    "Eq7BWQdvSpEznfxMcMkCxeG48zPMAmJPY2tHMSq76QfJ",
    "ATiJiKYxpymFsAhywkW1Jc36HHK2PQma2NgPLK6tFG1M",
    "qj18vXrsj4gxA6BrhdE2hAcmTJ4sUW1gpU8Hxxp8UjQ",
    "Fspob54KVE2f4uoZY9dXKa5yWKZALDbvcdaAudDndkLL",
    "GQFSF6rj3vBrSEaa9C5nhSnfqyh2MBMrdqkRATAoieV2",
    "7t7nhfZsQCgSZ7cFqzc52WcmbFWSMQiiTHnPmvBPmMZz",
    "5FpjmDYx9dhW74fZG3MLG53gUUAKisJ9BdSVLLHTGD6U",
    "3GUYC1js4MbQzS2ANLHgum4XThzGZj8WLubJCV1vqjMz",
    "DjkQtt3muGhfREFvGDVvTfJnySf56THgns5XAkZeL1k1",
    "ARTJ4gncoG9by3NrcT9vUogb6XyVWuTnX368RftyKpxK",
    "HexMNTMJxJxVbWZQRBnVfhuyeaBwgCmUPoVPGd3mArpD",
    "D5mMoo26T6NqJk6D3fm6mWnjpJxZt9UGzUqiCLmjk8TD",
    "FsxxN8Xc2RmRNUBRJdvU63E4pQzoK6SwyzLvv8Ss1Fb",
    "82Bk9zzCJrkSoyFdJt6zsRz3MMpSxptmnh5ZGJ5dB1Gz",
    "Ehpjg8NX7VewPg7kFGFVLCrDmnhqzbF1FCS4Mn2DemXb",
    "DyBMZNTCuZRpXDNT5MW6VWngkAoJznhZXPzwQrH8HH8w",
    "DS4VaFzL69XrQoQdHfQQBF8GNz7FJvLBKiGHM2RbSTYT",
    "27jto6dAsqVFvrMaKfaqEdbFNJ2c19fNUKCaHqR7hanf",
    "6Pvz6yvo5Ffjeczvc1F9oGFWcc385PBjdYP9CZ8QzWbi",
    "7THvtKrTAWFK64LCqV6RmT1QCbayxxZS84Gd8NranXAy",
    "BAR7u9XjQxB9sXvcembcmjkS9xHASjFKCpRjYEBrDmui",
    "EhsAX27dSkzvUvhc5yJMQbCKGa3wsyMM6Bs1vXRXLeRe",
    "4acbYrZMxHuMS2meLT35EugV78bzxyJ3hFELPZE86iHF",
    "GkDTzgtTqzHjkschpn8vMF8S9JMKURez62GTh29P8qpf",
    "6L4UpoHCby12JZKQ4LhJaeKqGXJbroEsrNcinnFASFTk",
    "FkZ1PpCgjdFTrTg8qpiv4zGin1ZDkHQkvBGq1beiWkSz",
    "E1gCzwg58TEGiQVNChHR2mYogTS9h4en2bpTfZMiCBP8",
    "Ad2TAsqi5tib1joyWi9LNiSjKJNg9pRegUAC3Hjn2xkx",
    "GX752LGWzNdfhLX7mEMJgeXg8M8Q286SeWykszaT1PkE",
    "JYx3Vh2vHbJxrDdD4bpPYfNscTBKjueHh746j3wJHk3",
    "F2KBXkwk56p76J4wyaakprXmQh7ZB61pzYGK3XSgWxT7",
    "EyJ2HtzCFAUxT9U9qo2qqgB6BGduWBs5wXttobcuN3rz",
    "J2vigdNQQ6Wne7ieVKf4wShteT9zMVN8673zKfKTDop8",
    "2gJzGFrQHTywj374YHjnKsHdSZxPZY5442QmvFroVWXB",
    "dFBU4D6bRLtbH4LbQxtQ8WhxEr3zNC5yQGvHoSvioMs",
    "CFLVfLw5uAawiKU7jtb6MDMysxW8fppYzwmk7dSW8LDc",
    "J1svDLwqEE28CT5JXnB474dGdaTgFBNxrNTaGEenZPV4",
    "CuGZrnYJyjbWShhzViXvhGJgxEwVedp9LzmAse9MCEPh",
    "FD43A2jHBXPWovfKz7FQUNDoi9wjcibhZjC2uNGiX9UM",
    "BySjJVU4gcNS4iYjqBipuNPHrNNWnAz7AxNhnA2ij71U",
    "2kdo5WXw7dNXLiHeb13vtmFczq4xtXWTVy6Smq1EeoZR",
    "BrVqTKA9Y8GFBLGEpUaRV8d9C37YgwRqFnKAT4E4TUKk",
    "HB8Nxfaj3Wgy4YzpUVWD8KhMuhpavx8mH7c5srGpDzPS",
    "AEFJg6aiaaNQEtfRMeacGnuR26kV5LwtBMB2VLnLMGCx",
    "5WvfuBFEXeJWhKx5ibS8ryCiDMQ4VDcYVmEcvMM1aUk1",
    "3LMX2ngiqFxWQ8Qtvsy731yPaQG72xeUdbWx4WtzsWxL",
    "734vkZCfb13bGBFdVjjxL5emCkrPiATfYwgGd5k3Nfrb",
    "861P8qdZug1WEj5GrVRiQ6fELN1UC6yVjfLsxpLtiHDn",
    "3GEzbCkpM9sHRA53bbu9278VEMs8gyp7Cy5sqEbEHqV2",
    "2b466jUQELsfK2fSPgxETQvDhpCbnL2KSW8e6dHk9Ar1",
    "8i6qvxVKCVouEhJxBN35TnereGDm6bQ4ncz6fMLrykQ5",
    "5FDR6CSNdwxfrtY8L1joRbH7KpqUcWD1gGzzTUiaTdbR",
    "2PmSux5t1jXAMew3o7qbL1s8mXULUUK3PPT7rSCNhSSi",
    "AvVmDxbZio2uDZwZu7uXiJRVhM5AhEZ8wWRj4Ah6rVR1",
    "2LCdZGKmYo7A5ntRqhqtugNczvbdaViKrYAXGw7tm31E",
    "6rsmJMWTDWRU53qynT5hDFW1uHZFzoSP35jokZ8os4Rz",
    "Ho9BkSv4Q8m2zfgfcBd4QsJv8dXnsk8NuHAmus2a6AeJ",
    "EPGupC9KVPdzhGHGf6JkddgeAw9guXMvWureeEMbrGPs",
    "J7tAgcDbbgv4fsi1boXKQJb9Z6nMYxyehQJVuDJ6ch2H",
    "2sMn4FS3qxDMoEajYEdGX2AWCjWLUTGfDbb7PHf9u8jF",
    "FgNyiEYEgAYsjXcrF9ehFNqE5Vez1Q8vrtuTzCsz1Tu",
    "7tSZKY8QjFnRPk6MY5EUAvpZidBSbCjx341jogQGncAw",
    "HsavXvnc97Zd6mJtxxqnu28sobyfjjksm2hwD1kjDpeh",
    "43i83LSxBmqQqbrDCF8npCerXjFAxMhdYonq7HxgRrVy",
    "6LzMxEC9wH23JjAhmtch4EUXypQ8WGCcmWoWGYVLbrMU",
    "DKEurqRXQ1ugJEFtuzv8kbfDe6t3LLCmR7nw2gcqB6jx",
    "F9viHA7wc581h5WNSJhTAAh7Kj7D9w5nLwjYpPkVfVYy",
    "ACHJZ8ygJraFZMs5oHysW7PLfy4xmuMKmQEbJj1NxjMM",
    "DU9e54N3aRfpiiYFwA2ui98VQ9ou5wiyxqPckNWgwEkE",
    "2C7hSDyiNbyK9qmvt3j9qyV7WZmSQS4o9R4o2JU4Krph",
    "CqQPiaUXiAvVmWkpM21XbMfGkzpeFETRK5bn4tHfeub6",
    "Chs6G1XcCu7JCJYCjgZwdojr5UCQTimMNpvTkyGxN6Kz",
    "FATxK4q4LE5xVQoH23zdwPZPdAhu6C2eAxRoMcHr5B8h",
    "CcmcKaR1uKvajTyxxNPYmmPr4hVy3e1FEfLNqTafniKZ",
    "Cq65LrwhfHzMcez8zn4wznZ9dnjtJDKDM1gCx99pEYkJ",
    "F3QQj7gGoHEE6vaengra6ZVXqFeqLHgse9qzLWUCyk3A",
    "Fz1DM423jdioW18sRUZuABrsjS7JhsFE9CBvjCDPMev5",
    "GsLpqYHcmo33KKKZqA13dfscZLf6ETgco4CZRGa4mYra",
    "HRXeNZJfSrLmSeyh7VvjfPN4iWwzCHqKHbzKE3j23YdS",
    "D3VgQdLQpTT27JYehRYofEHf3zin8gu5YZZGD7ZaYN99",
    "GJ2DSJ7uhe77o6dU45QwQP3S12L6axV6ttTCDvTmf4py",
    "5E9rxwWp6NgQvAjRVGaP61W44RMPQMkBcjvEKNiJJF5P",
    "BvqW2kJvgbfLA6mQEiy4yJs3mh74ZDp5xCr1SBiZvdcA",
    "9RCwKn1NuLBpn94an7iCiVRLnr8qdNjynd3tCiCByfJd",
    "46ZRReRkyrGcq2WaNxrPPW8as4osT6n8U3Q8KXFFNGqw",
    "7VxBMmbGweNqdetSxb7gkSDD34SaWaT2TVmJ39Jz5775",
    "H5JNTG1KQzfsH2PfjopdkwfxFoTWEcNYxhK6SfVsYy2Y",
    "CfzGDnFrsnBVZ9XFusBPMFq6AJbxY8EPe4AqNqXyLS22",
    "HrqebbZyXrZSvqaCmTuWvEFhjJerZgKN2T7yGcHaobQv",
    "3o2gKTkemaxxTZuCXYNnK2hXuqhn6vm5B6W66Xwr1L7U",
    "CVEWdb6GhHUHujSeZQvNtgZfoPXQr8QUfiRrVZvmZJPn",
    "8BoaeWVGgBDEbpg5822syUdDU4j7hySK8tDhCj2SzmZ6",
    "Ftvw3a7efZLbCWSRcfbqVZvcDFhnhoDZSHmLV3u6A6UJ",
    "HMWDY6i1voJzLjCKeS1sXpCNZwNxLXE3pYtJ9JjstLmN",
    "BFKEsXUQ7ESeSjJX5HU838KzwF2UrNbeF2DkVgxFcAKF",
    "FoHgJbRATiZ7TczAVPxHuajf4a6qRKrLQuftfDB76EWu",
    "8TZuyp7he1NN3RBWWdcWapLRggwZeSGs8DQ3aUuokqLA",
    "9JXWkioogAJNP4ESV8xUaLYdNtyvyBvDtq7CMA4Cj91v",
    "HziqN1621gpj6VtdvvRJgoD66ccjLoYeMqHodETQqZHB",
    "59vShiKvW8ZLYse8WkV53eBSDBkBozUqehbPeRbXBzWP",
    "9GRJ6JsWcKLaz9fMNdnhU2kbGK5r88DpnWjdH6VSjVYC",
    "9xp8pFNaCowVr7T6Qy5EXLuX3ZS7nF8YoVh7h2sTtUfY",
    "2astmMbUTtArmA7etHVqh9ZE3GhRNCQ7xG5WYQvSBSbu",
    "7p1qpzvQob4KLvQm3K2i36EKmwhcx9QGonvqWiw5Ayvg",
    "GA8F5iSAVGH7FupzeHuZ1xX1L3USQRWKZrt44qsF38ZA",
    "HKZeZzLZk24HyNjMmSfqRwTqgSQ5ptmedGpAxzwvVkg4",
    "GTdg3TSgb9p5mJrbVwU481d4Ai86kadWBpsfPmYAmoeU",
    "6bihDJGPYsnPSDkFq7FKjhWwq6ffDrTXDeWABV4TnzC5",
    "4taEMi5RQjrtBXf2KAwmS4qyeR7Zu2CpBp6xVyYEpBpD",
    "AQAVsLfZVQmQGLBH55ZeS28H6BbVdq2YdkBTJEeXYALg",
    "5aLYovFYbfFgsLLZ1FTgv4QXVdkBX989Ym6cMRsPYog",
    "7xxZuaMQRzbC2MEGyTtfNKNusa12DgKYMxBuksrt1CR6",
    "32fR94zVt86g2DmNNnNBnziS41iESMhGUn389GSHzPjF",
    "2Zwn2KVjJmrhNwjgZp9Sykf33TQFTFxbwYrqv4MQ6nE5",
    "4cz8mDNRuMAEYkXyF4hYzWaidF6v4x8mbqewC1CDqT4z",
    "GMrmvmPP7LGKRb3vxWNLaZM33EnLX1efM9GkKp3gZsN1",
    "9uQNAQpcVokJdS6hGBYTfZ6QUiQvuWGz6eAcAkNPbSp",
    "fPUdFBFkjKYcuSRKKGCE5SzuSXYDQj8XZXmiN8yW7H7",
    "AiboggivixjSVFWFFRMZc5YTAkxpMoVUohKoZALucQ4W",
    "7kT8kDxPyMU1cgAw43eg61bdsLbZPiZSDYkE7s2i9duc",
    "D9P5ut5To4GBuPXvseE3zKaTpDAs9t65FouoiAu6Yt2j",
    "5BW1RL8eznidbXB271wiGkNqkAeJnG689SKrTjdT5yiN",
    "7jJdrPKd6daGzuzWkBDFieuaLdT2zao45udWoogt2Hb4",
    "8MevhUtJ5j4ueNiY4r9gkMtkaLyeT4HzGQwUoT9W1d52",
    "9HwBNiBY31KXW82Z6KDsB8z4kkwfvWNdwCDBENJq9zmC",
    "BfNvrx6BpkTivXpH1b27Kq7wMmVnefrh5a5kEFzLFDbh",
    "DfuzPQNpu1UTr4QkRv7FFFg8rbfyiDHScsu8nAZ1x9JD",
    "69tom1k7qhRX8hb3sb2sqGNiEQPCag1r593SdmsY7NUd",
    "CuGZrnYJyjbWShhzViXvhGJgxEwVedp9LzmAse9MCEPh",
    "9E9YyT38p3YJ8sq2a74p6frkCfcUAXZsg3dKHwD3d9Cz",
    "3qUEjNQL2GwWhksm2TjYoMQ23e3aFALnaBgBPi8QWbar",
    "4PPHpKHvNz5qXX8ELSxcXfBSYk4r2EFrPE74WxrxLdAY",
    "AxBG2yk5ecDepB3wwd8zhTzdmt9ptX8q3qeG63HD6C7m",
    "5CgVnqwVAARy3buTAR3eB8TCnRKNXV9Fn4FCwQaYvgss",
    "4VDJQmJmEyDknoAhsaxyfc5fY9F11M9oFDV69eJLahWq",
    "ANLEir1PVpWqWYcr8r2iBup7uPGgcS6oreLLaqS5otM1",
    "8H5V9QAECPzUZDDR5puDdAq8amEvHMbzngwDyf7pav7f",
    "7UCKBHQrgzgFmHYixUiTNh7zofQjcxk5MRPchPU3wmDD",
    "F9viHA7wc581h5WNSJhTAAh7Kj7D9w5nLwjYpPkVfVYy",
    "Fz1DM423jdioW18sRUZuABrsjS7JhsFE9CBvjCDPMev5",
    "62qzPLwAsVFHp4WafGVey65oyRCX28uC67PzsJWdd8Wy",
    "Gobht59To24fJaqWQGcBt9GkDiVomxtuo732A58NExeS",
    "FATxK4q4LE5xVQoH23zdwPZPdAhu6C2eAxRoMcHr5B8h",
    "2b466jUQELsfK2fSPgxETQvDhpCbnL2KSW8e6dHk9Ar1",
    "DU9e54N3aRfpiiYFwA2ui98VQ9ou5wiyxqPckNWgwEkE",
    "8rH6jp82Gd82CK8DF5RSJUFG8BPTHn6AzwKk67u12Do8",
    "4NUJHTvYaqnhtNAeBm5og9EHs4sn38neZrHQHzbormzj",
    "EJxrEfHT7RrqVMEJeN2d4QTWkHmCBoK65RUdbsntFxsE",
    "HRuEpocZL4aKnqctmW3hW9kg3PJijs5wgpYScNetGHig",
    "JAiMEsEAXRbiFmADLdEbWwjjGNbMgvM55w99135KqTof",
    "6qy5ZBCQiQQgoocMpe5GrGc9qqRGREfGiezqbcQ9cw59",
    "HexMNTMJxJxVbWZQRBnVfhuyeaBwgCmUPoVPGd3mArpD",
    "D5mMoo26T6NqJk6D3fm6mWnjpJxZt9UGzUqiCLmjk8TD",
    "AETPpDqeSFRBidgF1oBYXhuVfZSg47LCTi3krLJgUMCz",
    "HU642LBvdoSFQ3h2UhKngx2LGGyY5ksYhPyyDsf15dNB",
    "HnMwZJQRVDPWRxKwTmbYezycrYffK7GduD4HdTeYtsZm",
    "47jLkjWyrr6iSj8AbFBGrcrpCryz23ogwsr1mv69nrV5",
    "ArzcLMp6Gz5sDvwRVGjyLRCUrev9m19XXLERvdUtxy1e",
    "BpmR2NBR3cnG3GBhPX8TVnPTNFQEisz58EDgbdwoAnf2",
    "63Mn2C8rp6KqxPXehUamcJoTVyMpLSr783cdZJdZ91wE",
    "7E34R9kcYS9E3ZFBf7cGvbh7ywn5h1fhehpdtnNpsmDr",
    "9W945X2usDmm7Tgz9AaqR9PymysudavbWwhfX3ZMfLoE",
    "GWpprT9tbxE4rikg5nRaB7GNzMjpqkZKB4pbBsgnh48P",
    "6ptgh6qn2PH9nx6autqobvh8iPiG6D9xNcna3wMpfGEB",
    "HpdHJcB6smf4AprrLCuzPdQhwiNh9Favw8oD6jGnLu4f",
    "4NNfBsv187U4M8uwJ3hpNYEp3M7NqMdxV1rzhTwmyeBn",
    "7d6MVjP8LRfN3FcLLutX5wyTQSERDAdmGRbUTKn8xiMh",
    "311whVyedsuNGQUeJKuc16T97CgM2NgLhqP2kY2qX71u",
    "8kZLHAYy6ZLdENVhCChtEt4z94vuuRfFstoEgh6iMiNY",
    "HHvFSACo9SRmtsuMhufF2NkMMiJvaE41zp7QYEgBtm3F",
    "GxCmbXVtCYdNo4trh3nNLVdNUsXCS2vA7UMx2WePkGTi",
    "7cF7GSuCPGBh1C2zwDgKBwn9ivFKN2Sx4jajffgVmh8a",
    "2Af7GE3obY3qd2a3trpzzFcwZCEqLwAwZA6zFhispMAN",
    "4k5CXSERPFn43h4mZ6pFqKKBCQp5yNN6NtQnyXgAQ7h7",
    "8FyiEJMy72VfsFnmysKrtqSa5jJGjXV6uqhu4prwifNM",
    "AdShzWHGAaizGzUoCbStkoZWoiQzdGoqXFytFTYN86TN",
    "6FTvi9pWhsmaFiuoZeg8WuNr6g9aa4XPvQZMmpoHvfPk",
    "8R13BoTkmXFK7rQ6EXNjzoGJkgPzjCUXp681HR1gZ9t6",
    "6yyjkbPX1HMEibmXHaSTheg3kdxqKVNAhBPTrap52NhU",
    "ETtBYw7XEeF99WWpTKVzq7GMiR2Uod68sBAPT1V5Bbqq",
    "AcLN6o9sHVEzumxC58gcnCNHq1tFU3mD9QHCmLbJj722",
    "6c8D7tUjP5HPFtvJxRyBtkKbxvV4zD7XPWNUwfsgZVSF",
    "HXmztwDiCZubo11FCh9YPNUW3wQVpKZnuhfMZHh1Gmow",
    "2em1UzfQNhFjKmXfnW1CkMBgYBuahpAdxsFNZxjmySvZ",
    "6XYpfswxN1z2nFzqKYhq9aiq5xGhNezfAirDDeKXUqox",
    "H8Lxxq3ordefR1T21dJ2UHbjj9TWBidJRd2NBBaPUmpo",
    "Ga1GYLgrv2QWJAfgWJa2bHZHoigMbKd8QJRm6Tv9gjw1",
    "Cmdo98oFhwLYpVk6E8DgbZTEDh1qvRRaDiKaruRZM6Rp",
    "z9bFk8e6115dUE2gygvKdYvph8gb1KcFUc3EsLNz6vg",
    "6KCLx7awpiMbgVBimeWGm64QKxws9wj6fJLAfa3Doq7q",
    "HSTsHigCQvoeKs6JBS81T3wgx2PraCnQNMk7gyW25G5L",
    "6fNnahEdkBkdCGxGAiavsmk6S2ovVKTT6RbmnSRMiaLM",
    "6j4wPaHv6v7qGk6Rjgx4HUsK2c3KKtmh5u1sPVnbb13C",
    "FjFzh2NrKLQtfWM3MaAv4PoaVkfKK7UhL9P7DBjsV5rv",
    "BorqjPVqUXrQZyfAiXfvRi6C957TpqjyXXnRop7PoWoZ",
    "dFBU4D6bRLtbH4LbQxtQ8WhxEr3zNC5yQGvHoSvioMs",
    "AZijYjAnYQc4g3Y1W1HVg5cCYquJzaqz5XmLCFLYgLi5",
    "9f3iyEszuvHgyDQbw2DLPvCfjma9fn2UtWGGw6BWqhpA",
    "Dd5THYYrRAKBAMVRXe5LeoDzSyBC3N64oaUQ2d8EBufw",
    "27jto6dAsqVFvrMaKfaqEdbFNJ2c19fNUKCaHqR7hanf",
    "F3ebHXRVZF2emjA84U18AepQRbqhg5NbVotnZQEJ37C3",
    "65y2u5DkCHrrT9tHwZmZuArLdwr7o6TjRSWVtz4n5tPj",
    "ASz9oVffxzKjX23b51iZsw3GXtzERnkoiPpXa7dQEMP7",
    "25HGSbWJ8rFPkcCNRz4xPkYAFuWo8PLkWA3dJ5Lox5yx",
    "3hAYzfCaeoD8VaK1NHWmeLvdkhFaKht4SBzVSetZwEZb",
    "DNhMwebrY6hvQWdgEriYoGLR5Dfrnd4wwhBdbLDDRqC9",
    "HMWDY6i1voJzLjCKeS1sXpCNZwNxLXE3pYtJ9JjstLmN",
    "Ed2bTo1NWPKeNf3xA9og9iXAE5fuU7Pkoxiz9WJnFcFz",
    "FERXtwjBuvpPDuEAivmxguVzwTyd9X2HnzdE2pLp8rRt",
    "7sPqXb31J9kBk6szVY8N5m9vhcyrgvgctnXg1bMjikii",
    "7gr3nsdkFCypUGVy2KXtaPhf8EoMYHKb9Cx16nzseABP",
    "37xvXxM72NXAjZdmTDWgHajPZauU8EfQoRHn4ywyV3iy",
    "JYx3Vh2vHbJxrDdD4bpPYfNscTBKjueHh746j3wJHk3",
    "33vypG8pVzkjNtH5n84ddT55BPJwQAYM3QGmZmgRecH7",
    "8xecQdBdDr8kuC5CJQBbpKBMuEHD6g353vX238gkhhi8",
    "6aVwkgQwiCMBedtZRLFe9eWCPPiRRrTnPGGRKTsvj1hU",
    "FiKDWx3PpqPrHXvb6SVctWE4hFur165tNhkdf8oEEjTH",
    "9WaTioeD8CWNkLeDxMKkaxVTZAEfdx2CsVWg5LAPUPSA",
    "FcQi5y6sGbAfFz5MwsifkVbVFr7r41y4wCmBxFNv64Mb",
    "HbEEnUMDPyCbvapheWJuuzWNM9V9cwrVPUgcgUzC8LjH",
    "7Bc7NxxzVMcZRXx1oEEGJktnHDDEMpcpjTDJ8bQPLEDH",
    "E94R2Bc2DsD21MGNkZxwcrF22aAMHTHHxhSdy2RaQkF5",
    "67gXgrXyqEG1GCy2VmFjFZjGC78SWgTAjqA4oVKrkbUx",
    "46ZRReRkyrGcq2WaNxrPPW8as4osT6n8U3Q8KXFFNGqw",
    "EryQTHwBoK2CCeagAGdu34wH2dES2HsRx3d6z3Eo93bG",
    "8ow3SpPDVVgchvpm15ynwW4Y8vGK1BhGvfF4eRca3k2A",
    "2Ms7vy5diWisMvKXTJAboi4UDk2mAQeTiPvWaR9KupFK",
    "9G3gBy4vakBUXJTw15vSrekihHzabEdPfw6rnC8tqFq2",
    "XDJyTDpuYSkv86anaDcQo29hMY7pM1jr7Vy1eGnP9zj",
    "AmGrRndwoRaEuyq8EmjkuMdaaV61X4GwrLfCfxnnMij4",
    "HUVfBnHUd7Fj4nZfFKE6rUMH3ddhHsjfcjqUgjAmH5av",
    "64yjAtuCY5Lkb43jFQsxSBupDx7V4sF7b5sxVJZ5KWRp",
    "6qy5ZBCQiQQgoocMpe5GrGc9qqRGREfGiezqbcQ9cw59",
    "CcbcH14f2CjTzaVxBvMv7kwCNz2FdSEK7HkxH3pU9PPE",
    "H7e9Le88HmMdyF8EZxk6vSmj12Fm813iTCwHWBBFes74",
    "J2vigdNQQ6Wne7ieVKf4wShteT9zMVN8673zKfKTDop8",
    "CApi94y855YzK8PntJV1QRiDx6xvvivkPsYaRF38JvDn",
    "AVvSACiePpymZ14tHoLT3a6v2LxqSwsmzcbravXgq27r",
    "2Ho9zvBc2X9fpgsqXUV6MN1VSEzSH1difrLmkJnVmaA5",
    "HRfyZHW2UDjZyfsKnEgKbEDARxyJugFMzCKYJ2gjaRjh",
    "4ZKMB976hXGepdvqMui8SysNXFcDefEGFRXc11ZDEeE3",
    "82Bk9zzCJrkSoyFdJt6zsRz3MMpSxptmnh5ZGJ5dB1Gz",
    "BQye7CAZ6KmtsRi67Usgju7WD3QiYxKdTxkwo1joEFD6",
    "FriJ3SwEZ6Ujn75Xo84ghe8WfqsoxkMEvGfe21DYA2kZ",
    "EDY7FY8zaLDaVJpj1x7mKhSbiMsHfdDRGBEckba7bBNN",
    "GJ2DSJ7uhe77o6dU45QwQP3S12L6axV6ttTCDvTmf4py",
    "EYtRRnBdd1E16CDRxGwPECwpcFGEWnqsnxHm1cK5vcoU",
    "ECqnJwp55iga5EfEogSMVeLvAp3HgBoQNxdqArXsVVuE",
    "CFiZ2m11GgfHQoZd2d5RG2iNYFmwMcsuRGDimfpf5xmB",
    "3GEzbCkpM9sHRA53bbu9278VEMs8gyp7Cy5sqEbEHqV2",
    "7JadM1EiLFUy9QpwBk87aGEr7UaKBM4eg4WDBRdEigJN",
    "9RCwKn1NuLBpn94an7iCiVRLnr8qdNjynd3tCiCByfJd",
    "7u5jutRLbtsAvZyA7uXUawUVenMnnUGQBoHC6kSj9g8e",
    "ATiJiKYxpymFsAhywkW1Jc36HHK2PQma2NgPLK6tFG1M",
    "9JXWkioogAJNP4ESV8xUaLYdNtyvyBvDtq7CMA4Cj91v",
    "9xp8pFNaCowVr7T6Qy5EXLuX3ZS7nF8YoVh7h2sTtUfY",
    "4cz8mDNRuMAEYkXyF4hYzWaidF6v4x8mbqewC1CDqT4z",
    "Wv8Jda4SXdcuh3or7JZtbrbrG8LEKAAUNhXXuC3r7Yy",
    "F33hoo4uX5oafuEmx1BSUGxrCGivA5x7jsuBMQJmgPaM",
    "GQFSF6rj3vBrSEaa9C5nhSnfqyh2MBMrdqkRATAoieV2",
    "3JVzwwP5LDkfaAJ1JUaBqZjeN1TM9YLEaznmQV9tbVjR",
    "49HXY6w1eSfvD1G4qmi3TP1mitcEaeuCwpobwzux5Mi4",
    "6zCSvdRfuxz1NG8kGnCNpjdtpWp5MRbZJUwHxM5Tq5bN",
    "8kwnagxxUp9jbJixKgwJDz61D8jNud2mNCRjzhUQcg1D",
    "7s5rKbg3Wknw7w2P22WKun6AWVDFrbb4vJMxzxDfwWh8",
    "BuwgbeEHC5MPhXr5KFkDxWJXV12ekumvF6uc8zkBy3E5",
    "A8LrxJg7LMBh9YFKMpdFT4qhixxygmc4pE62HpZurJ3S",
    "4NX6cAPdaXxmY1GHDVbkwcTQ9uabRhcM9e9jvzWZw8zx",
    "FKMHWrw8VeKCUbS4C8MXasLki1HyrDGrc2WNRmoV12aQ",
    "FZb4pRsd9iic6KhBoE9Hjxoy3LH6NpUGZEyJzzeQr8Zu",
    "JB1duJ5sLgysAncgzAkoDPHpaNTcYTszMkouL66fd5i5",
    "734vkZCfb13bGBFdVjjxL5emCkrPiATfYwgGd5k3Nfrb",
    "Fspob54KVE2f4uoZY9dXKa5yWKZALDbvcdaAudDndkLL",
    "2PmSux5t1jXAMew3o7qbL1s8mXULUUK3PPT7rSCNhSSi",
    "AyQnrQs1vCVmdPY94Xk6YpqYxa6deyfSiXz1E69VscJn",
    "2LCdZGKmYo7A5ntRqhqtugNczvbdaViKrYAXGw7tm31E",
    "JBoAyyfmBtiYui7k4NpuYmv8VPBH2gFfDQHLHHq82Hkw",
    "KD4aQiG9Xcd3a3u9QSLi45B4pBNX5sxJNzwCEgYEfS5",
    "Dxw2ELRXrxX8xqPQhhkZ9aJHGcCHt9ERFfHDwxf427wz",
    "5os3JEp53zEzP41EFf4M2o1JbuqFSC9sffwdqVq3UQcA",
    "C9t43itxqcfH12VyMP5y6cnP7kuhzCXnkcxyRPTDt61g",
    "4cwFmR3zYz5eAXcnWDdbwWmUWwbv7ePX4vo59JPbV38p",
    "EkgepTa8dTysRiPhWMdt5PkD5qc3KkV2XfdNzxQiN8AN",
    "4APuHwEzt2KgUEvsaQ9Ez7jociVyecjKkAk1BymLpdx3",
    "9qg5AVTTicSj2HdhuFf7UT252h7bNnYd6eJ2eJ2tMoLV",
    "E1gCzwg58TEGiQVNChHR2mYogTS9h4en2bpTfZMiCBP8",
    "BySjJVU4gcNS4iYjqBipuNPHrNNWnAz7AxNhnA2ij71U",
    "9aV54RMFxCdXw9bJu9PDvaQQNswy2nc2rcBzdY1RMVDE",
    "1JrPTqeGizTHRdm5vVwLEJLXejyYqAwU4X9mj5hzjKd",
    "8GJDEJ68ASFMUnsq8s25vV8H6wzAM119fuxTGhFhgFF7",
    "CifwMcvbQZYnpaT2kHCo5rfXinkyBvE8LWw3Zz5r98m5",
    "EhyuzsQMGQh6xPtQRV5YFn9i1f7PZpqRbSb7XLzQcT1s",
    "HNLyjsG94J556PfhaX2YACL6wqPiZZmEHB6xLUodrC1r",
    "7gqNtYqQz2DtYK43Spg79W5z2vjb1nXZGcxtihsDe6Ah",
    "E6UdVz61X5j4JHvqpTKHz5DtxCWYgVVB741tia5WSm5b",
    "AqbY3rgMxyzyJowXAqKv5D6MLz1BiK4n5J5S2XpcxUdU",
    "FdXgMPj9xqihKnmXkaue5Li7ExmuLASzRR7K1CLv7kQM",
    "FLgtFxcFx9zSi2ikDk5JTdeCr6qjLkqpGsghgMaSnimF",
    "SGigKcGCFUUKKm7e8CPYuHs3ik7LSUfqTCdEQuBSjJz",
    "HmmrMkuwJTb4Jd3WvxvMMmsgWgoLXS534pNmQFSSdvrU",
    "ABVcfdkoqHd4QZWMD6B3HN26upA55BLmQrnfZu4qKayN",
    "GxqvrSEhiHvajMySEzvY8rsNS1Gi73wY5YQEkobGazxm",
    "BMApFpmHUjUM6sUoTnMxJoT71o1cZgCjR5W6kFzwDHBM",
    "FaWryjsKsic3TxpTrgXPV1bxZbhBByf3t99ajtYLCBNq",
    "CHjzCRoMxa8ig8WFDLbg64Lo1gRQRionya5amTDx2af1",
    "ASz9oVffxzKjX23b51iZsw3GXtzERnkoiPpXa7dQEMP7",
    "AXVSthVcy8SKaUD2TpQsGU7Xm6jqZftXiQXTxizR78o",
    "CguiTkutxy4YuJswdAkH8X23tjXzzKamdSQahjUM2RRL",
    "HWN2Xs2rzDh91jvUTgcQHbMEzx2yfUdVQBEWjHwKnngC",
    "Gu8ar6HprahLpLm5Lytj3ZUG99Tt2F8fuQgDQ12aiZL1",
    "GkDTzgtTqzHjkschpn8vMF8S9JMKURez62GTh29P8qpf",
    "6L4UpoHCby12JZKQ4LhJaeKqGXJbroEsrNcinnFASFTk",
    "FkZ1PpCgjdFTrTg8qpiv4zGin1ZDkHQkvBGq1beiWkSz",
    "AiKPbQYPwtGRJkvaagtknoQTgQXRHPLhRDQ2AHpZzo7Y",
    "JCuHsMqu22uzyjC9GFQHo1rcRLSMhSXfwpDUcKq9jheH",
    "F7jSNtbN8YkiF8aZWCnSh9182yPj9w1eJ5kg7DsDganF",
    "FFqoLdZXCTtrwPg7pFEXZvsiqECSFGJa12BeSWC7DSzk",
    "GXUqgvUe97k7Qa7pe7Q4JAG9qE8fJqwjcH4FuXSLRXDo",
    "CTMfYmZoVg7Jy2FBxW7PFbWUkcMt8v3mrYUCLmXGQY31",
    "BANS9ApzA3FobEu2pSf67KQXaRi36hJZBeCSys8zekLR",
    "CgcaoeAUKgpK6HWFnHy6nbP8vTs8YUJ5WaVi92nJK6qt",
    "A3oUXxPzTYiQMZciAccnz3XKBa71gAU23XHCsa9wQPid",
    "GmHVykf27bW2QAYvqwQ4ZBoKCTsLmT3TTZYUXG5jdS5G",
    "GX752LGWzNdfhLX7mEMJgeXg8M8Q286SeWykszaT1PkE",
    "Hw22iZKqsVoryg4CR4LetBaYc6X1PncwkUzt9pDTsUyK",
    "2QFuDsSqGHjNT9HrDsQrHTY4dc2asanDhEJz4n8jhg3m",
    "DGv5tXqf5LV4QRGaCr68USRwx9rtyihnnxeqFnvFSUq1",
    "DwxDR6zsor6a93ETF5C7yaz9s5JHEHoAHaqKg2eDEJNM",
    "9zp51WM2g1hZjyhzxBKSzRDB2288Z9E61zf52KJ7RYs8",
    "DXXnNkSu9o6F4jo3ibKkxd1FhEgHSubv8FceKCdz9DzM",
    "2pk1Gq8cEvhtMnmEEWce3L7cve7Trv7Ph4sqdaSHMc3s",
    "AXcQCgz5uLTakc6d9FU2p2GD1VXn2ReWsAswkbHGwhPQ",
    "4yMnBazcNj2ov6uueXRKjups9Xcah1U6QkBukrYdVCLH",
    "2gzp7Zd7ExJodRZuuQTyiHXoD7aAh7fBjMdyfJykybxj",
    "5FDR6CSNdwxfrtY8L1joRbH7KpqUcWD1gGzzTUiaTdbR",
    "3LMX2ngiqFxWQ8Qtvsy731yPaQG72xeUdbWx4WtzsWxL",
    "46ZRReRkyrGcq2WaNxrPPW8as4osT6n8U3Q8KXFFNGqw",
    "2C7hSDyiNbyK9qmvt3j9qyV7WZmSQS4o9R4o2JU4Krph",
    "8GHH4YXGM2xmDKdKqhypwK1PM4xu4eU9wuQJvo2cPDPc",
    "7tSZKY8QjFnRPk6MY5EUAvpZidBSbCjx341jogQGncAw",
    "CHMt9vjMg4tNMYNAVsTUfGNYqRTVfCStTDsE2mbuLAqZ",
    "861P8qdZug1WEj5GrVRiQ6fELN1UC6yVjfLsxpLtiHDn",
    "6xyx5kCS3X5j2j2q1uMZNRW2hpYe7notC4pXS4wopDJw",
    "Co76K1cooiabZN5P9dP63kR1XD3zZH9GkSNfiBsXcG8v",
    "HVji9CcWyYX26oiYXvgPikNHqj9uha2AUiyrFCGVfxrs",
    "CsCGuvGw2yYeA8Bs5hoP9fuGxfW5hNvixYzCPRL3q2iJ",
    "6wySQ3RhAzz9T5n9Gm2nmP8DAMmiJXZ9y7Yv7trhJdtC",
    "3Hi6Zb9nhCJ67J123XLLV2psgNM634e6vDzwrXzf8paQ",
    "GcCWhqtAKAg9ewYs2TWN21cdFNyRC23gLRsARV6GVSKm",
    "EEPRMBqdeWtkxQj4AkyRRx368gLYEcUGUxaUPyaVkYdP",
    "9igu3uUj5dvtPpdG62xdLJxyJ3qVvf5ZrcrmE3GZmgvT",
    "4Uix7NSetrue2pBSv7TWJ2mLEmCvmqfq1B6CaxWALbQf",
    "4NhZPXV6RYtuhmUFjWRYnaz4oQJe5Tm8SjoC62vPYqha",
    "B7EX1ywXHXNiwmUQrnxq13QqrsZpsGThoyPnD7paYxmj",
    "AAAmL2ke8fEmWNZrqqvYBMTKCkMfhLs8sR59VKcKWAjG",
    "EhyuzsQMGQh6xPtQRV5YFn9i1f7PZpqRbSb7XLzQcT1s",
    "HziqN1621gpj6VtdvvRJgoD66ccjLoYeMqHodETQqZHB",
    "5aLYovFYbfFgsLLZ1FTgv4QXVdkBX989Ym6cMRsPYog",
    "FnoJoxuQ4abb3hgyvrgbMEoYrjehFfwVFqVow7M3ZJhn",
    "H9ZEpmnUiwQVnCw5XCwLcYTbqwAYB2z98dZYDDfMMbpJ",
    "8vbuLskmBobbZgSpqjwhPvh4MssJgBG2twFspBvnaR4Y",
    "52uPdKLfeesUAyNz7ALCD6pG43PhnPzY2381Efpz5V4u",
    "ED7NeHBNVtUSpvbyjAyHb62r6HnLgkcaLKqEAWEw3fXs",
    "GhsTo7aVRAGAuivnZVE9kX4KR3Czx5CySvcct3UxkU1A",
    "2HPR2DGvTTpngDyAequ9d2AMM4NnifE9d74rk9MRCz4H",
    "S3GKdsXJ81wC2exkGZhuHaf5CNVygdiD5ij4xVg8z22",
    "9HxfnUcaoTAUBN3e7jr5uuQWyMs85q6yzb2j5BZL6Bv2",
    "Gs7X4pWE8WbS5VDfkXxSURucPNWjFqQi6H8VfpCPYTfG",
    "DvEYxjo8ienZ4DKoFexghePV4Q7JyBJDxBZi2oberWTC",
    "FVeWApxu2qT1ATBxa26auv5bpa8eXXqrZUCLYohtES6D",
    "3jds6DsAhChHi9LoHcmc6swkNuuKTdLySAzkxNLiEM8a",
    "9myQUzizu5rsc9u9xhGnGCJg7ej58hZFQemxjKknaaUk",
    "HHQFE5tGP5K2TgVpkAa6BhTApyQwa1Y8EM7c5fnTy5mM",
    "H7NRKHMjjpwrAfxXDjpSYn9cUMowiZ11e1EebHP4E4ny",
    "74jaZBu9eF8oqDu8N9WMDdL6qViZko6gNhzFEr4CwuDY",
    "Davb4c3z9BJRrJeqdBhbgcPCPkCeZKj81M8qNDHW6eaP",
    "GkQFPz1SDY3wWfUg98ufhcLwvZm68nUQUJVgECqKdpRV",
    "67U2w21zBcUoKRbaQUB6koJPrAJK3BJEbJbCn1BPSFw",
    "FgNyiEYEgAYsjXcrF9ehFNqE5Vez1Q8vrtuTzCsz1Tu",
    "6LzMxEC9wH23JjAhmtch4EUXypQ8WGCcmWoWGYVLbrMU",
    "9oekCTGFjFJCzmEEKpye9SHD6nh3mg2aTSZeBzFTEjnX",
    "GsLpqYHcmo33KKKZqA13dfscZLf6ETgco4CZRGa4mYra",
    "GCT3WW5epwKdLJzggnRy9dSyQ1TEsmSqsqkvsUs9ypiL",
    "9RQP59PYRQCqmHLz6HcFqEUQwT53YFHMazPJuZfhSYk1",
    "6Pvz6yvo5Ffjeczvc1F9oGFWcc385PBjdYP9CZ8QzWbi",
    "36ka8jAPhc5MTXDvLYbHfKeod7DoJaPqPsvDK5bGEcZm",
    "Dht6hzSTmjTGDk2gNQy2Zqnk1oZbwWTwyo2SgmhuEsk1",
    "Bv2mf2Y6LPAaXjLZRe43qfVivJCYMfKRyDqSenEZnhwv",
    "1JrPTqeGizTHRdm5vVwLEJLXejyYqAwU4X9mj5hzjKd",
    "ECNidAXMVgZQYfn2Ywf2FYRUgSTNzBvwgDq3sMTKyYbh",
    "27jto6dAsqVFvrMaKfaqEdbFNJ2c19fNUKCaHqR7hanf",
    "HvsmhnGEqFpGMtMGsJ47yL9pDCVEcxJ374FHPuFwwLrJ",
    "4pnBKZGEDtbUuJtKUfDWZxfv5wLNsNcV3X7ancB1e6y1",
    "EP4eSDpBPoJiMGVCXVAtAqVZ4LWhU7mLP8pcw1VkS5oi",
    "3kr6Sd7xXTuehNj4qxa2vBgYUQM5p6jiqY1yZ6bVBkHG",
    "HjL8WvfjVDJxBwtKyU5yZT8pe6AMbGibxLd8KRtaPgaA",
    "61ER4JMoqYgLemGxM7z1swVPbPJysVbfGVvX5kNUwkS1",
    "7dGZvqy5T4UZqqpY1LqFHSH9pp68y6kSLccBqi3Cci6V",
    "54RAWmkfix1G5nCdP6aXxMdSRH554xFpdEaD2j9tC1iQ",
    "5qxb1ZDPdK2gSfKb6hf9HdbnQ6tr8SG1enr8BcJCkLXU",
    "2P2yK9RuoszfgZGnwaDrpmp5vrZpiLKNwFcTSX9fxcLC",
    "GmPY9ZAELw7dLvLhJGPybp4YigpDxHbjDajjyrArMZTv",
    "7pwgJkZEapqRywZUHTa1GHoCczZTVV76bNC3MrXps3QF",
    "3vttmwY8ojFLXbirSmvUBYEJ5dAxrWbF621mWEVR2JKP",
    "F6AAnoY311sYTV7cyrzUzgEYrU5Ymne7FkRxGfXoM2HW",
    "2FmLEwoWnC5BfjmvSC27wRQ6rAMDn6zhm7NnUYy7Cevp",
    "Ay3UqtLDNgKLvvZYKJNxQqpV4wsRmpdFyKHxjZxk3jcW",
    "215iF4Ay59wZ3kGS53vh2sPFNzVYxhYWwZ3nergjhBwq",
    "9ce7rXYsLdMYar2WEtj2Q8vQG8JLYZ4cEEdMyskiY8e2",
    "BajH6QDbSDevpsq2JMvJkeDbKs6BoRY5sJ2YjeM5dNnu",
    "GtWv1EqMB1k5CL8uyJmKfq9ST3VcYfczrWer3xsiEJCa",
    "HiYcPgTPxTUZxDqQ3dRaP3CBLkpoLonc1jNMpcNbDCrh",
    "9jpL2av7gHsqAg5ZQMYU1uGufki8R6Kf34eExgaY5Mnf",
    "9eaDFkQypqbTMhkjexX3VB8sgZ74MmViBN56QCSLoNec",
    "DNZDuV1ixTLYSUBYZVQaERwokR2zbHxmAw9bjmcegRoH",
    "7EencvatQmTrEX7WX527g1zSi2nuuJziLV6QiSnsapEg",
    "F2KBXkwk56p76J4wyaakprXmQh7ZB61pzYGK3XSgWxT7",
    "A8nkT3CBttnk6ax3z7MDn6qxpxcaN8S8tCKKbb7yDA2H",
    "EhgY8kreAGbBYGve9mxmnx3vD5Pj7phmF8LDqipSTU5t",
    "8KcakB5V2gW36k4U7rSwU3KQhCbXBKB9sLKJLMZQyp96",
    "EE465WBoJVyyhEyMUnFbyfYzNMXbqFBBYXMNxJw9f8bQ",
    "4yMnBazcNj2ov6uueXRKjups9Xcah1U6QkBukrYdVCLH",
    "Cizw6AGw4qRNQ4agRSot7M72aAb4pwQhcT1Ufm4pRg2d",
    "BEhGsRpt9XefVNi9prVd86gJkTPK35fsxooCK2iMXLd2",
    "5NP8hvGnX6hbspT46eoYrRNcQaLki3oNj4wV4cJaAFph",
    "Et7SH5MEak5VKi15Zy3H7XCfP1ELFrRNcQKkXebyNqJ6",
    "7okef3fjrYKDERLPKzuaG3X1zhCo8vbGULib95uZhhU7",
    "C3c5v4vu27MBwu4pwhgP1BGDqkBmMLvAzrHQzZGpN6G1",
    "3vvbWNBfYyMJdUvJiq532R1JaCoNJGyAqFv5W98raezb",
    "DpYHtQ3CRgYWkuWLB4GcGiMaZi1BaqWvyPkyw4HMHpun",
    "3eXHL7k3wP6GiZAawcn3Gxek2PvNzHy6CXErgVHVidmC",
    "E3ira2yeLbU91WJpekGtNsF3gHXr6RE7WBUmFpN1gJNW",
    "CncwYxKLRFDu1KqNiiwhLtYw6Ls3NbnnRHxxYYP2uEAr",
    "EAKNKWn4GN8u3AExCzKu4CAdQwr5J3nwDcSeyoW3kqhz",
    "7gedPdH9rBvNPQTnK8mspx85rv2b5waK7Cm2ESZBy6uv",
    "4z5SrSdxDyPPgthNUmMrwoehK4xBrVuQd9uhrRBy9SrP",
    "55o4V1x3bmkA1Yk3iCCiZuGrDQjtMrL3yCvYgZrDTRop",
    "AsTw5vBqKDHSiFo9YHeX3ye6sMuqCY39LDGLd9KRf4G1",
    "E94R2Bc2DsD21MGNkZxwcrF22aAMHTHHxhSdy2RaQkF5",
    "ACHJZ8ygJraFZMs5oHysW7PLfy4xmuMKmQEbJj1NxjMM",
    "6Q121uRziSXaKucqBpuHyn2V9JuvuehQbvdTzN5fcg5k",
    "D3VgQdLQpTT27JYehRYofEHf3zin8gu5YZZGD7ZaYN99",
    "ES7P4GGz8AYUVVCwQJ7EuLsJTtHJTsGkJsVK6ZcKbRdA",
    "7wn1PuhpH5RFC6jsnnhHt9R1CYvghMmXY3LpHDRXXZVg",
    "GFZdE5NKv9Z7RPVYRPWknFapyU3dmAyoUVaRNGNgnxEB",
    "9rwxHPsZA4CMAwwxiVnvrFjL3fX7d749V5fCGy1J2hcX",
    "4bZnqbkF7qPtBq3sEuu5qraYhg3QMMG8vcnCZqjZeegQ",
    "HRXeNZJfSrLmSeyh7VvjfPN4iWwzCHqKHbzKE3j23YdS",
    "7ESRSVS1FDvqKjW7drNKr5vF1DAnJv2ZvLdySCRKmxUS",
    "67quYiDaYThfhKbczu6SGeWW3wvx6qeEST6uRtG9Uj92",
    "78BxjyK3j4tDgzHqK3Zi4125DRkfCoc4xuA6kmUdxLYc",
    "7kkJpafPGaTetMXPMrJjpc9tmRRy5uGskJdT5MTcxXG7",
    "2b466jUQELsfK2fSPgxETQvDhpCbnL2KSW8e6dHk9Ar1",
    "A797zAsA9dYYwxaGPzigZgkKo92MpahQMLVzpxf7FMAK",
    "JBFb9PUwPcn4zk2B4FFcGWAstkxEoUaUm1qdWJBS5jY9",
    "BSSHZgMggVvdJfYL4cURa7ZcezFnPDGdGK6eeD47nJpW",
    "2yWLcKHLWAgi6GV1L2ANmeTBs9cvYJTseXErLNWhD3W8",
    "3KwqfxFhxjf7YJFrePSBUQVVJjdWcWUmh4ck2ykLp14W",
    "zgLpXpf1PfnbVt5xxgrMiHxdZqVmvZPzRP4BScAH7eh",
    "BU8XpHexE7vJsmNXTkXL3fwmhzkirTwXo9uXbVu7Sni",
    "G4KYzSPEuWWmZaXPSqnhoBv3CU2X57tanvMou9zk5wwj",
    "2XmwEpMJ4jP6TGbXazSMj7sFFknXxMQ7gpPEjdMHYBNA",
    "DS4VaFzL69XrQoQdHfQQBF8GNz7FJvLBKiGHM2RbSTYT",
    "EruCrP6yvZxPTuvAmvSFu3MojUFq81bH7auxskz8e1Go",
    "CQZpQJeYa4eWbTcyoATRvccEpYryUQwDRUNmN8s2JVHz",
    "ARTJ4gncoG9by3NrcT9vUogb6XyVWuTnX368RftyKpxK",
    "5h4Ehnn4xAhpugjCT4w3k5baNN3BMNyiDZ4HYpMHnfYA",
    "2ipjyFHHgoCbtbJLSugb8WrBh29TfGcY96NjomerU1Hm",
    "8dH9e31hpL4jdxkibMsTgxBuSHi6C1FMqrJbQ9eUBHjh",
    "BTrdgo8NSjsAYztSHsD1Wr2P9dEZwGUe3vyas6PenPfo",
    "3GUYC1js4MbQzS2ANLHgum4XThzGZj8WLubJCV1vqjMz",
    "BLLKvQsYSDNCw19aFjpFDLa82Pp6oFwUhmeXEYu1TGHC",
    "JBbH2wniraRU1YjzAAFWwBnC4oPYhb5wvFkHgvdJ4Hie",
    "EYKfuLpoN8rhv2xYdpBuVFJ88Py8qXMFaXEY6XTyYhn7",
    "7YwupcC15AKpN2z6Uzoreocg3W57eJCsgqhKeMtxfPbk",
    "D8ZNrcJezpm85UaqwFW7MJNcBJzR1LP9fiUXfktTmxB7",
    "3TEq12w1NPdArCjcUyXiUcLca2tMkarKDJiuEeYE79uw",
    "bwNpMGHpNT6efTmUFdKCtrsBvwPhs8pjyeBo2DSb63M",
    "yXGj7e9wkarQeykRoHCTDYpTrPFq1oLx4gtaZatbGn6",
    "A8nFWGqPQGv2eCzc1Xet6SWQWvAxHb3w5tKYJ1tiXbQ4",
    "C1uhvfeuLfBXjqynQ1aqw4sHbm4uJDGaYkqHUCnQCorQ",
    "26ZM57kzGQ2wjT2A4HAQfCCbgEJj9BjnUsVVW1hCsMG7",
    "3JfC2v79j7FsDuD8if9ea7ohJfp8pkbgugGKNCwuN8WH",
    "4z7K3hQ1fWcfLmhAbQxUeUr8PWBz8KfzB6L9PF7YpdW7",
    "6V6sEbD5A3HqbvyyX3Mi1K85SgtyJa6SdzgRmVY1Skyq",
    "Heau6MS7ZVo5hspbX9GjcjzGjM6SX6GjKSZeAT95g2Mn",
    "FcH3xS6aK46JATs3VGCeYAvbTnFtbLtzEWvf28LDDdek",
    "81fFTyPTjy1vVKudgtw5FpjctRVTYTsUB7HVYNjmdDLf",
    "CpxHrHUf65NyBU5au23F6Vch8xebascpbPcpDUNThEw1",
    "CcmcKaR1uKvajTyxxNPYmmPr4hVy3e1FEfLNqTafniKZ",
    "CfzGDnFrsnBVZ9XFusBPMFq6AJbxY8EPe4AqNqXyLS22",
    "2ena71b2yNaiwDJetbM7N6AyXp2pWepu4WaNBpL5aVSL",
    "DixTUvdFFUiyN4bwe4FxJafGUibkf4B7TDmdGZ9DhHzR",
    "57iPfraRqkiFePRkuXEbPmK7PtwqKfFJqyF5o8MdadEF",
    "7UKMpsHvNXsyVefaWJeqBWiuXBYzJEYj1kXv7Wi14Zfc",
    "3XgUXuLbmLGZ6YVQ1F5ZF1nYxvTSHasJ78mBMLBjV7Kq",
    "CaVFKewMowWMbQ1678xHt9WwU92mxLRSTmRQAXmWD3d4",
    "D7ChTvtsVJEAgTMTYks4ByGb5FgDjAHSboHepjjdvqTC",
    "8bVJ3Bp5xFXrvu8L4hP54UHtETP8kM4NFpyHTAG8864S",
    "8NtJ68roPsKChV4jtFk8nfdVYz94gKTkSauisEwD575W",
    "GKfQmtEnFGj5WFydfFw9PnxtWWgY9SwoFJKjyfxG6iCo",
    "Ax1oqYyT44BEDYF4Q9CGkaT8eFo4G3MDRnpLkoCuMyjz",
    "A5bViJmZjijeEykwqhUsn2KDkbq9DurK7zwSbzJ7Jqub",
    "J82DBcZgq4Hp1fMJusoBKqFSNsyyG57PWCCuzpTg8CRD",
    "FGDykiCt7FCjyt2SBYWA3AhJwSxtsqMP4fqwHkGsXx8H",
    "2eVkvVQ5srZ76pYTxFVdZjAbdgZx9Qg6YKnoFsHdo45S",
    "Co2zfDBbyPsAkVb4eXtffNmKmZiDeqGbVFRwntJacNaY",
    "5QX9GfVrquuoaUM5h2AFTr7mB2KACE9oyFegtGsty6eY",
    "Bkvv1Pw466UZgts1gHpb2kBNq2XkfontvMzpTS5S9nTU",
    "9tPkQSJJ4wzXCimLdN7cNGG39SanKZqkC8nDWdBarT4x",
    "DutnDAxCsutbPXx3eaEXvrujBbiZtEQ2btV4AWzavMe6",
    "DZmgwBPY1BFnbh7JgPS9dNDASqJ49v9p9LUKyk4sopSw",
    "6Q121uRziSXaKucqBpuHyn2V9JuvuehQbvdTzN5fcg5k",
    "4taEMi5RQjrtBXf2KAwmS4qyeR7Zu2CpBp6xVyYEpBpD",
    "AQAVsLfZVQmQGLBH55ZeS28H6BbVdq2YdkBTJEeXYALg",
    "DLbEFMwLszqrvqGPGoqw7Q4AdLCSifGyEE4KbhUJ2JfN",
    "13mgxEsdRELKi57uKn79SvYUKKStaciXPWpzCQehV3d",
    "CbR9243z66a2ZudrZL1HwZFbPgxTLLWFgWnjYnXM5u4e",
    "5PDBS88RSYNP4fqw814hn43aDNBHMSbWmYLFd6JD3iko",
    "5U4rWKzTbeVZP8Ds4usp9V5Gjbho54yt17j6mmHBf3JZ",
    "Chs6G1XcCu7JCJYCjgZwdojr5UCQTimMNpvTkyGxN6Kz",
    "5QJ9UFF4VVv7nUcJJfmcLHv71m5yMYh6aNLSxvfrWEb9",
    "7SeXjpZRTUgg9LHJoC8RPUBiPhn1RnkRk7aaSaNfGW1A",
    "Wv8Jda4SXdcuh3or7JZtbrbrG8LEKAAUNhXXuC3r7Yy",
    "EJxrEfHT7RrqVMEJeN2d4QTWkHmCBoK65RUdbsntFxsE",
    "8kwnagxxUp9jbJixKgwJDz61D8jNud2mNCRjzhUQcg1D",
    "Ho9BkSv4Q8m2zfgfcBd4QsJv8dXnsk8NuHAmus2a6AeJ",
    "7u5jutRLbtsAvZyA7uXUawUVenMnnUGQBoHC6kSj9g8e",
    "Dp62nR5DNaaxgbmStJsXfLkmDUBzYvdcsdU6ewEQkYev",
    "BFKEsXUQ7ESeSjJX5HU838KzwF2UrNbeF2DkVgxFcAKF",
    "HhacGc6UECSLRDpW28rNbSX8JfkDsbzoWG7cou1h3QgV",
    "GoipmM7MCXw61wo14o7F1JdBasEqnwEw6dx9bsftNPUt",
    "Ftvw3a7efZLbCWSRcfbqVZvcDFhnhoDZSHmLV3u6A6UJ",
    "BEMqMsaMV6CVBzCBhXJUTUDFq5qywrNK4GQrKLB7BwLs",
    "7aCmCWybj5H8HnvEcyuC1j6Ei4QT57XEtHUn5rU1nK3t",
    "Hox2jkf4teCqLwoeNbsDGzXLYqmrmkCHEe3t5mgKUdis",
    "BCKBBAnGmFgBACJHaj95fGLXLJqyBLcLZxe5NKhNhiCT",
    "J1niiiYLw7S716psBU3t6jNe5Vka5BN47BSLxZAhz6VS",
    "5E9rxwWp6NgQvAjRVGaP61W44RMPQMkBcjvEKNiJJF5P",
    "HjbwCwJGcUWGp2R9ybT6NHE2yCN5szBQWJmbTzVGM1XN",
    "2Zwn2KVjJmrhNwjgZp9Sykf33TQFTFxbwYrqv4MQ6nE5",
    "2cnXFfWihbTB6t4jNFbyqkwx31iccXsJW8RESrhK3246",
    "6DsMVTECYbZ8i8WYFFLidHmVpUryTvbAH5YhvAVDg64s",
    "CHejwBKEY3sTCD5Vu1cKTvppMKJaHbfpwvtKEum2W7C8",
    "ATiJiKYxpymFsAhywkW1Jc36HHK2PQma2NgPLK6tFG1M",
    "6zCSvdRfuxz1NG8kGnCNpjdtpWp5MRbZJUwHxM5Tq5bN",
    "JBFb9PUwPcn4zk2B4FFcGWAstkxEoUaUm1qdWJBS5jY9",
    "32fR94zVt86g2DmNNnNBnziS41iESMhGUn389GSHzPjF",
    "J7tAgcDbbgv4fsi1boXKQJb9Z6nMYxyehQJVuDJ6ch2H",
    "D9P5ut5To4GBuPXvseE3zKaTpDAs9t65FouoiAu6Yt2j",
    "7BXCyVSxpsnvsvuDR1J9ZcRjKmLyeLiUxtrXus61hjBN",
    "7HERmVAUWviCwbd2darKZ3VnZQAEcPsE5q1b8EVdjHBq",
    "DjRiLXvajy7uey22upzeP9rbBuz7qRcavQp54vQrJ3EX",
    "3xjn97fprYv2KQoqPMZQjuQDtCQMgrSzapNCseukLAUr",
    "DjkQtt3muGhfREFvGDVvTfJnySf56THgns5XAkZeL1k1",
    "C6ajPd2t4Md9XS7TNMH7t1Pv2UqRjMVk68XQFYVe8S4D",
    "8BXjJCJuatSMkgYTPrV3MRG7Cd1m8z5tqbVv5s8yw1C5",
    "5C5gpxCsNmfVyoz8qsBsv1uTwbpiLRKJvH8qwdJQW3ji",
    "BJ34AY1m3X1iJjS2kdHCq81D7vPBwuQZUJo1eRjVvUcD",
    "B76z14Ra1VETjJeMF1XQ8YzaTy9fNLeiyS6jg5egXtqd",
    "6bFWDWJx3S2vzdYgZ1mDFDDDQipctrdMZQrW7SoJBBEA",
    "2dVeK1bSg9ijLgomo5wNVSfqvx5cmLQ18qQcU4HxkpcW",
    "C77DnyAeWEzKPsNm724VRDrRaPDvkB6gjCFweiXtGSun",
    "FsxxN8Xc2RmRNUBRJdvU63E4pQzoK6SwyzLvv8Ss1Fb",
    "22tmpUHaivH1R4akcB4fH4X7hGcBZ5x3WukEDrG591hf",
    "HexMNTMJxJxVbWZQRBnVfhuyeaBwgCmUPoVPGd3mArpD",
    "BoHFB16cziT5y6sUdd5z7hTxKC7FTy9DzSakZ8rRAfoS",
    "3ykcXWD6UWpiHRYsaYkPjwVfQNYKmesrsPuTTtMDCh82",
    "5gd6nnMbNogZosQVsJ5uxqZgjqiHHRzNhQf6zJd7QDxC",
    "EnXyCfLUdzhWLafGNeox9mfpZ6DzXz6xRNA4pMtH1jML",
    "6EnSrLnPeFV61DhRHVSsrjUavVhcjghhKvoVFHoLackH",
    "2UbPzG5Bwv3bdGgmgkQyz5EHhc6bqW2H8CBURJuYNot5",
    "EwcoQfkMcHMkxUZEZEonnRgX7vosCyZQ9tw1KRCLEpjT",
    "2Ma6V2ES9qJYxiJiU22JAqY8vZYYcVVMnovgkY65ux7W",
    "BwTF89Bvv69BHhV3CDaLhsnRbqbBpinwMMpNVmP3HEKZ",
    "B3mNvjZedMjiXhw3xvXd19XN9nfkwcif1PqrVJ8mpLom",
    "GUhMcWZnizp1JVXwTLZQHDQdQFVVEGrNnsHjVF723Ynd",
    "EyJ2HtzCFAUxT9U9qo2qqgB6BGduWBs5wXttobcuN3rz",
    "7KMjzB5jdRsvuinmkpMrxC4GuX4tFhCjn2MiYYCEqPcL",
    "HxGjGKhdqCXYT7zVHM4mkHPJpvjKxPGFXQC2Cff2hTaw",
    "G1MNF1rReZX8XNhSaYbZLTAsT3bCftiN6RTSpPbk9FLJ",
    "4DS6LcYekraNzVnfGFe7wXijAtQHHsZs7JrVaW93MzEh",
    "GsLpqYHcmo33KKKZqA13dfscZLf6ETgco4CZRGa4mYra",
    "BLPsWaJcxzHKJHmkNAmjeTc745SrWoMfS3MEJdiVpGpx",
    "AxZUk1xhLTXLZVvBE54kiRsXPK1viigtrF7y8hxSrkCV",
    "37S54p6PiKPAM6828Jk6jLMLbrXA2HKKaZLQ5JxGes1f",
    "GwvsPPvVeP9mhdH37jHiEDadbBAPRyifH9pjYn2F2eDe",
    "E9MvtG6jwU46yg5BtGhkcd3k44ZK3DrWnnkYTH9pKk7V",
    "CrKnDVor3UodKnRpUdZnC9NWjg8qhWPRZeJvjTBywnnt",
    "JAJzubCSn9hKaAfHKLaZkj5PFxYH9BAcBAQ9cw8cozCC",
    "13cBLwgngH8Syvxm1D1q5TXsr79n58VvijMywohTEvRt",
    "9mtH4Ctqw6wkCiB973juxbkXtuUbTQsp3nsJ49dHafTs",
    "AvVmDxbZio2uDZwZu7uXiJRVhM5AhEZ8wWRj4Ah6rVR1",
    "Frw6V23yLwBh7LszWjctURHFajdw3VcHJZXv9gfBQZfS",
    "EVyYcd5GcLEuvb1p6hrXzA1RTF7LQQSCLVz1B9F9eXUZ",
    "DF4SoqRsDBchbGqNnCsyyeGJbCrZ1KHEKX32XMLeRRhT",
    "8pBRFf2wDDZXfJPLBgdnPd7duSVfvPJV2v9kv689FiR9",
    "CstCACwFK528e4Zdo3rNxueKXrmyVxynVnv3mPjRh5oV",
    "CFiZ2m11GgfHQoZd2d5RG2iNYFmwMcsuRGDimfpf5xmB",
    "ABZD6YacydTESd4zccEeqJqxW4M4gBLuQyV8QfqpcQ5a",
    "k1MQd3W67yeCtPtYhUjttbhPWaXixgEPvsMYvLuLuK7",
    "EwuQoYL9LYv65Gwo9UAquTnjxyakjpAcaTbHRQgGF43W",
    "68QioG4r1eSzc57NPGY1g3uSep7CFfGmc7EgbCBNwp1U",
    "2MZQq7zF6N2DNhaqD8GNQkuRV3yuqGLc4vnjahVwkSEq",
    "5kPPDdUSunkZX45KLofJzjikwyZSjL3WRF4n4xZ3Mv9H",
    "6usUR4ccqXmFVLtgkujr2kLk8Lx7mGG5GwBjF5yKwyg7",
    "8XGqQnFuD2rrqeMxAH3tQHqEdUNxGKySc1tVf1pTaHnk",
    "3NC7SQU1o2cYrcHb883grt1oLCWkt5UXi1y8Z2o7Z8Cw",
    "93X4TLqbDU9i8HW5dicJPRusHviQWBtDQonEG8CkdA7q",
    "8uvCgCekFsjyTBERgXo1WkaV84tVrWzDaE9Y2Jew5d2t",
    "EuNbRJUQPSruC4XpWX2fwoaEKFouYuWU8NhA2dppZuCc",
    "7wSfLinEuUWWvpnb7GLrPho2bRPY9pKgGXhs6ztCc4NR",
    "u686r5jrcp9pH9bK6vUnXAv8g6JA2fgawwF4eqN16QN",
    "7bavc6ETsoA4pKNCekV4JXiB2TGLK9xZ7y5ztVfjUpfM",
    "EWT7hmV2vVYRbj2BZRWQxXduZHDV69YqbqjR16SHrZ1n",
    "DyyAqKEuEH6ts5rdh6BsDoJM2tc444a7xSnteEvGxf9A",
    "DX1VGLdT5tHJddTznM2tCFHeAUxLri89Q9ZHKcxvbnCA",
    "7MGJyUhAywkjD9s4yCcYTcbmX1jg6daWapsbjUuD62R",
    "2sMn4FS3qxDMoEajYEdGX2AWCjWLUTGfDbb7PHf9u8jF",
    "BCQkJBGhPQ4JWtGpSvJrkhEwmmg5D6TqXEoi1Hw2B7xM",
    "5kX6dY2ek2APHVsErZ3XXcubi7aSZMhLXY6Kn5RzU4m4",
    "EhsAX27dSkzvUvhc5yJMQbCKGa3wsyMM6Bs1vXRXLeRe",
    "F3QQj7gGoHEE6vaengra6ZVXqFeqLHgse9qzLWUCyk3A",
    "HuxUxkUAjLkdHyqw4L8FkAwYtkd1kLTHBxKupKYq3aDZ",
    "B6njk7FqKARoneEjXPsoyYxAf6BimMNBPGnzLuNnGWnH",
    "2kYsqXwcfmRb6PabnALLKkae1xUJ15NeZGw6z85EVY3G",
    "36ka8jAPhc5MTXDvLYbHfKeod7DoJaPqPsvDK5bGEcZm",
    "9cSmno5mcQbwr54y7dkhUJ9eDGjj2fDJtj7e9DLHBemz",
    "4uoa9y7f742BYNpemL4VaZ6pyaiNyw5RQYDixGGtxhb1",
    "DTaX4usvWGXELc6jppRaoHRAhDrnogFMhJbDv9iz9fUj",
    "REKTg2ny7KuPMwiTAabXRHKMBvGDGMXqW3QKAtbLL1F",
    "2uRmR1eJdBAvNQir3ehGmNKbUA59KDnp2N8hfZiaFjMJ",
    "AWFQXwkAsUmEJGS54GGoUsMvaqrWmjgYBsTXKH36Qi4Y",
    "C8xvSQNJmANM3Cgmd8N8M8sS4XSn8spBkJm88w6gq8A",
    "F1mGxr1Mi8Qz2P8QVGtWYDv2wyFSSC2enh5AqUTp7j3p",
    "Eq84K31jxr12pyV7cGhMEBqDCTGo2WwtoSYNQtdayAoK",
    "Huw5H3JWa3P5XKuSaD9ERFTwjVzQH5XMZ45cSQumUo9V",
    "JAnzRhgkHg8pixoqZ4PWjQjPm4wWs9gt7j6j4pE5fUY3",
    "C1hCt5mhDnVrpF6LWZp9c3jjHdMEUNeqbumtjiuDKUXf",
    "9JKR19JXBr7DpbqcCAqRXSBCutgZbMJsh9mhw5Kk3AVL",
    "979mskYbGUhFY8iDR43Q9ZsL2a7amYxPyXUUwtSA7DkX",
    "HV7zveTB5dBxZrJPe64KQStZPrbyQw821sA6XwrKtzGb",
    "DLkn49ugKsRXrPtpJMewbYrYQMNEPuW6g5gqVk6vxC6P",
    "2FerHdvvjdz5S3Z8VFKMRFBBR4e8TwtgUXKZFco5vttH",
    "FRz3UuqCoDpBxaupJNZKG6TzqoPno8zTw7RAxGdCaJC5",
    "AuzTP3kasZ8i7zouWWgd5v8dQSYNch1mVxE9u9LCDVD6",
    "H3yCLoLjXyiAEN91BdLqZwEibtUzfivLcGWejrKvcpC6",
    "3tyWsfsmm1nDSBVvbqPiQuu4jTXxpRLdmtwBvSVaFAvr",
    "FxmFATGHTaxW5A5YTUqkQGZ3iECt8Deq815bhoMt16UJ",
    "74XjjNnDGpqwv1586Af7q78ZnQ5NJuSW9GeH8nRvH3hT",
    "BneahDojT1qEtw9zkvX2DzPHDnte8SMWyb2m8gs1d2au",
    "CMo1GgHyUGcYmJph1Jc9NY6YiU9MVp1ma5yo4yGQfHvL",
    "HaPVXMztcwnGpwPVUUMcXActPM6ZxkuhQQLtVVEmk4NU",
    "25s3Nea1BTE1BstD6j5RPtTd8iDUZoetqPgNPGa7hgZG",
    "CpzgBeWWvWaHWNXSXupW9GsRZ4EsogPUsYpXs6QDEXrm",
    "2b466jUQELsfK2fSPgxETQvDhpCbnL2KSW8e6dHk9Ar1",
    "Ehpjg8NX7VewPg7kFGFVLCrDmnhqzbF1FCS4Mn2DemXb",
    "9GRJ6JsWcKLaz9fMNdnhU2kbGK5r88DpnWjdH6VSjVYC",
    "4hgkYe25WUVsYkbNtuwwfsye7YwATnbUwixv33viPyEh",
    "8vfUTn1Rm4YB95tXdr2pczCTXeKTWJ7c61JRLksKnBE1",
    "EPGupC9KVPdzhGHGf6JkddgeAw9guXMvWureeEMbrGPs",
    "7FpkQpV2byXfEd7rfxmRCcLVSjraUn51QvtptK1HXuVG",
    "CgAfHhiuo3ByNemj9DiBfnpHBGYVeLDMVBbYQDYJkWAu",
    "8HXJEkNSnpYxMocS4M1rnH6g4uNiHMWvV57MsCCyf1vX",
    "2ptTVTYq2dhdShNjoj5bkqJsZCdekKzDwezd1Jvdu4zx",
    "2gJzGFrQHTywj374YHjnKsHdSZxPZY5442QmvFroVWXB",
    "2SyzMLYSfpSM3v3SfSnjk3vXESbGc2Z5KqNCJTkHH5rX",
    "G2H7toJ6FMeHS67Nm2odBisfsdGivF4oJYBp6bmnW3KP",
    "Ad2TAsqi5tib1joyWi9LNiSjKJNg9pRegUAC3Hjn2xkx",
    "Dd5THYYrRAKBAMVRXe5LeoDzSyBC3N64oaUQ2d8EBufw",
    "7qPSwKANT8UzMxDNUtwqDvYs5cEFvdPvg5wY1TNuScX4",
    "AEoYFBeZaAwaBVWFfJHVftFG9pQNvpQZbyBrgEjRuEW2",
    "Fr1HYcw81MAPeGTxTca8APUqU32XTp5yaeaU92FvX9fC",
    "GkrZRgTUFGzTsd1AQBdRGo37kokrakfpFmD9JTkfzoyg",
    "HgZEktHpUURKWJFnYBUpCSmv9DaNGSfM3E2LhaQtbH65",
    "BKuPHVR7r11rtEUQENdmSLd8pNvLunL2nqv7MFos4NbU",
    "CJbuvbnAckN6X23HohMzL2KZ6NyH5W89uFbapqtRT3DG",
    "7DjYfTJJX55VErsFTwMZbTT4EoiBt5XSWQZeEJkfuATN",
    "AQobDpThmkNAY965pQFYKLDzNmwe1zDWicGYU1x4JQJe",
    "EEDgmSBNzBcbUfXcbEHp4fSCB738EqJXRmsqpokQJQz2",
    "DyeEo4sQiZLtAhvS6mJ5NAExTpQDUpUyPiY3SK7U8NFf",
    "G6pELsW1sZsuYUAhhLm3ro3FmtniZjGUZWwioketyAwr",
    "CUP1rkqELVExk39njV6svnMNUL4mRwoRyH4NdJG52mBT",
    "FH1WtGTiqWZwAm3QbDqnn3re9E44aCJp3hvWtbJ8LMES",
    "DxU1zD59DM6NS86gM6dr3dSma84HYFGU9FvWvF9sCaeq",
    "Hmuec2bU7eQzizBfoi3MzeW22Mg7mp9xtjAmZf9xiU9R",
    "8Tdr3ns7RpS1McXmATfTpuupJrN5ABM3mek78dwH5XFf",
    "A684cAj6D4xDnAtK9n3ucBXwMqAqi1BUgvErz5WeSHev",
    "4DymxxjEz4qBvh4mts8cinidYhug4GVznfLMAJJijwj3",
    "Crv1TCU9o4iaKpBzhCGvF6jNQGoVntSee67bfeeXvrNX",
    "AuQMq9gwHxAheaBAKxb6FqHQrQ7WdHqGaN7uWKRUbpUA",
    "BoUan37kxCtqRQbEkw64fDpH4wJ3sUF1xsxPsn5EpkDT",
    "D9gdKHGm1dUnzzMDFgwHMUBuyfEwttYfMZABKgStGyVE",
    "Gu52QCutkZiaCxPbcfTU6TXSTcLAnPZ6TtrVXwGiKcq4",
    "6fr37e1wzBVKDZhdYznV7zBikM8mA1LrFoeNgKVpkXP2",
    "9jUWD5PG3gLnxPkWKf4unCue22RDui86AFLTHweVuoPP",
    "7KZy6jge3nBXgi1zu7yDzqhAY7rrxyX4YAqbZFxu5KsX",
    "7THvtKrTAWFK64LCqV6RmT1QCbayxxZS84Gd8NranXAy",
    "56tzr68gAJdCcvSswSRfANPjmigwCY2qzwSTPqKhEHG7",
    "DxGXCdsYxZiq7PG1axosWv5ENth1G572Ata9gLtHo9Rw",
    "GFJ1wkLgjtb7oQwAnN7mnCd8c6rNd1VgB6GtCfuDyiYW",
    "DaAu3MF5grVNnZR7uTH2GcJignApoVACHPyKLpiVirC3",
    "66cm61gEqVBKeFLsfoFAAH6HtQ3kwmUBNpUqnLqFEdgQ",
    "DfnFp5RP5ZPSnomB3SVwuRfSHCzARucMYs8YqbB2KKZc",
    "8vKMj5TNjE87NKuEnt4RYFhoRfRJMbBPjFugf3axmyQC",
    "DuccDV89h91VvDzY9vsuGYLiLHk2m3PivMsPgAr3JJGC",
    "F1U4Js9LxzPTggSxHXyLm3ZjeFsPi5b8PX7EEPyEPeJh",
    "H2JEGqKLntYbXWAG1k4Da9dEvhWBq3Z78oB4LnvEg6Z9",
    "6uqdmZnNvtZJz8s3uZfEWfMjSBVHNLx8roa5CFkdocsu",
    "ANmmgfxu6KxDb5cRfiyJYfdTkVSC11rq1C3DHHWnsk3q",
    "9Vut9mmBGQTjUzh137DCGdGVsvAHhRekLkntMDPWPAKP",
    "BAR7u9XjQxB9sXvcembcmjkS9xHASjFKCpRjYEBrDmui",
    "BwWbcS92nApnJzNcndD7ExLq2NH4rXy9K4t2474JDqmH",
    "FRz3UuqCoDpBxaupJNZKG6TzqoPno8zTw7RAxGdCaJC5",
    "HWN2Xs2rzDh91jvUTgcQHbMEzx2yfUdVQBEWjHwKnngC",
    "3C5ExMJLDRZKmbp5psDqwQEmSes6ubGmk4ZupKTC1tZR",
    "5C5gpxCsNmfVyoz8qsBsv1uTwbpiLRKJvH8qwdJQW3ji",
    "Btsp9YVh8tuJjFsoEAJunwNFeA5GEtdEkHPpsqDXdVkM",
    "A5L9HxxKNEztJRyretAoGWNuYDso5YXFbuVEEDopnaPs",
    "DQuTpy3pKkKd7ww6dqRzed1siZ9EmNMru9fMJQ6HuoRc",
    "4acbYrZMxHuMS2meLT35EugV78bzxyJ3hFELPZE86iHF",
    "CnjTMJJxfjEmoviZAVpeQJ3LW25hx1cT2iyhBwX4HzXQ",
    "H5zLBi7a75Pq5UUU1VnDAuNMCR7GJQtiyq1zqcNiQniw",
    "7t7nhfZsQCgSZ7cFqzc52WcmbFWSMQiiTHnPmvBPmMZz",
    "8BaVT2hXShrxQbcG1qrgTbWchpQaVo3MzemwEZfYByuf",
    "CG7cwa8t4HNom7wGC4HYA5Je9xygedtUVmnkBwrt6Ucb",
    "AV85AY25QgVXcz2c4EWJP6VX9CCnoPeCoGk4qgPELYfU",
    "9G3gBy4vakBUXJTw15vSrekihHzabEdPfw6rnC8tqFq2",
    "7hH9xzQRuZbVUGfZySkc1ynEvUBBn58QiJhqb37nVMzD",
    "4trrexpSeg95NgeGmzdtYp2kBJwE2wrF1HAgehaBMxiA",
    "12nbBA2v62QoF9PNaBLDGnR6PsJJHtMAifgKjgNnF8Pk",
    "CUpNt54idsyFb1vP3xwLEtTDmVsHKDboUBVqvuRTcS7i",
    "AZiNDh8KTfzdMK6oqDhpBB4Yc1Zeq22yfxjbeXdDmUfW",
    "BMdtj7xdZHtirThMbFf3vJ7tR1WBoEa7bpzJjGcCsSM",
    "H5hvKF8qpxzY119AZ6TEE2BG2eWiERqTwLbZgB4Qbgah",
    "EJxrEfHT7RrqVMEJeN2d4QTWkHmCBoK65RUdbsntFxsE",
    "FD43A2jHBXPWovfKz7FQUNDoi9wjcibhZjC2uNGiX9UM",
    "DYEfmz1PKv6Z3UjgT5kazK6D8PaHwR96k4wfABFMDgh3",
    "7dawGbuhHsFC5kofgyAEWCuNHAGWmRfcKTLm4cXMEWkQ",
    "EkgepTa8dTysRiPhWMdt5PkD5qc3KkV2XfdNzxQiN8AN",
    "8FbcXgecLX7Ad71xu3AujrVPhzgJ2gzk84zsw2iRZr96",
    "GxCmbXVtCYdNo4trh3nNLVdNUsXCS2vA7UMx2WePkGTi",
    "3PkiEtMZ2ZPPenxpLm1A8sC9tUaHyGUHbJhrGZkMRL6h",
    "HdSF8x8wx4h7ruThxDSNDXEzicbKdpzLUXwCGoR19kxd",
    "B5jfNJJTRyXjw3VxgB2WbzyKZEaALAz2bMz2fA17qjoP",
    "CVMQnnfzos7LrVn64VWkFkQme1AoyffmKG2RdaJNT6Xp",
    "2upK4E9bp7Y4v3NvrdDTrN6pp39rRxXkAV2ydp24feQ7",
    "H6jLyARgct8EXzcNjE5XzZj7HnaLkKzhD9JRco2B9Lbk",
    "EcES37DyVwUj3YsL9BTuu47nkfKWVkrJ7jCHYdGrZhLd",
    "EtGfePYut74VNXWUsXwi3xv9yneKnX5aGqhoHq4uWeeV",
    "HB8Nxfaj3Wgy4YzpUVWD8KhMuhpavx8mH7c5srGpDzPS",
    "Eq7BWQdvSpEznfxMcMkCxeG48zPMAmJPY2tHMSq76QfJ",
    "BrVqTKA9Y8GFBLGEpUaRV8d9C37YgwRqFnKAT4E4TUKk",
    "5WvfuBFEXeJWhKx5ibS8ryCiDMQ4VDcYVmEcvMM1aUk1",
    "4qGdAvMuy6sm8abPi7UPbS6oyYmrKPKQF8PtzTMNtaf1",
    "3EKp4WaqyMsVaTxAeFVsrYZuojUwVgu5V8yyb5kcU6R3",
    "9UNU3w28u4BGBbaNUwJN1kb72ixBbKs36ZMXiC9UCMAR",
    "EH3BvwhzA9tatT8nYS9x53m1e48Snjm5WHgnuiAEgCFK",
    "FfC5kQT5NwGyHQaXeq2ZEYwQB9A8ygtNPNzRMBFpPXkB",
    "8SSMiwCoukprfuAt9spT5pYUwoCbLxkW4JXNRNRdXW5h",
    "EkAwGSPVadGHYJut4g38donAk9LoLvNw1pAPKvXELeuc",
    "3qXHVzeADZtkq4HnZknu49JNHv4JdpLfXM8Zp8xf7tSn",
    "9Eh5gxJoSXGFnFP3nwZsUqjgMuNh6dJUueVHuzzrFqph",
    "AET9qHiqE7yVkweCK6hFX1xaNnrfS1Mm2FqvZThwZkRy",
    "2BHAJSHYrgN6jK6DXqqD5ZiYsuEtmZ99ENcKgbFCqaWh",
    "7c2fT3mf3P7mLhLht4fa3gYMPFnTwT5uvb6fCCW1HAyZ",
    "C2abWHh7RnSqLaHyWsA3wXVjZHL5xzsPQC4XgYXCbk5d",
    "MPC215EfCsjrH4dyA5eYjBGGj7zP2tiHVEqHqsT8zMP",
    "GrM95kALViXCPyCNgHiDpXk6jNucjuVXcZctHSsXHt24",
    "AxKiWEMexPyBue8q2QsG6ptRK2Jz7SvoHi8WjLaVsySq",
    "96XubyEXTqb6MWzkjWVoEQqfuS9HQFWYpw2rC5LiSuTT",
    "9V1t68AcFWMyzBCP1bGfT964ztma8t6a14NH6rECS4tv",
    "2xmG9Q3Q6hSKzw59kqm5yiuvDzqGtrYMPLnydVTSroJC",
    "CdJgAp6GP4UJPu5qBz12SPDz3Vv8Mdg9FmM98q6XGuhX",
    "5tro4vYcRUGzkymLbCgpnKHfmGHz2dh1Dif9GUN1iVSX",
    "orP5jfKU53XpVsNdHrDMq2WZAN5WVi2tBUzyGqHEVX3",
    "GFi4kyWNMLGrwv6yojdZsNp8RZJPByiphb1ZaZTDcppL",
    "2BnoGkkAm9TTiM2BXKXDTrQWHbUo8pzKTJyb7qx9vSz4",
    "6rmSaChuk6q1ZMqp9b149pEckGXvxoReWfAmeU4HnB6n",
    "6jUNj38Dz1VbD1mR6RbBCC6TXrSErgFo9efSaSbKaRoL",
    "5JnDtWLyxL51DE6z793hhWtGKqTnAneeRr36R5W9sdaw",
    "9xe7DKT4dxwv2nRN13yNs5QrrpH3E2t5P3uREo8YF6n9",
    "8wP9dxGTu82eR8cGq8sywwnBJEcc7vTkaD2vMMHLiA53",
    "6eVSdCP7XuxjtK7Gc5ogz6QbogbuJwRQ2M5UCZbAbuGv",
    "EaksQvydvoKZzYodqzJbXFo9BDrcVskngSqzppMxvJWG",
    "DT976xrfJxaMz5b294bzuToy9HiNoaBTptYyWhNPSAo6",
    "BoV3eAnHVombzp1zZeeb2zYmVxyyCHdHKykiJNmQLtjc",
    "G4eZiL3g7NV481UaPxsbgLTCn6meRUzJ2h9xJ7ynFGLC",
    "G5mFVUg2YTRohuM8zQoShkjmzoVNatwacq8zWPsVqWtu",
    "A1u5AaLeiUm4QcN6fZhieTyrPx6Sym6PDhcZEH9fSray",
    "6uXDRTgBEZv5cvabVUSjF3KqfiMHs5TCykyz8J3Sy6X8",
    "GWpprT9tbxE4rikg5nRaB7GNzMjpqkZKB4pbBsgnh48P",
    "HpdHJcB6smf4AprrLCuzPdQhwiNh9Favw8oD6jGnLu4f",
    "311whVyedsuNGQUeJKuc16T97CgM2NgLhqP2kY2qX71u",
    "7d6MVjP8LRfN3FcLLutX5wyTQSERDAdmGRbUTKn8xiMh",
    "52fpkCKZt8jruoxKXptfDRJMRBVMHQ6uWfA1zw2271Sv",
    "GL2qH5m56YaqtXbog8eHgJPSgA9LG2Rb6jV5GnmiwL2m",
    "EsF6CQR76RumPTLD7NscbF7dbTjhwW2BwwPVnwhh3m4e",
    "8xecQdBdDr8kuC5CJQBbpKBMuEHD6g353vX238gkhhi8",
    "qj18vXrsj4gxA6BrhdE2hAcmTJ4sUW1gpU8Hxxp8UjQ",
    "5FpjmDYx9dhW74fZG3MLG53gUUAKisJ9BdSVLLHTGD6U",
    "D5mMoo26T6NqJk6D3fm6mWnjpJxZt9UGzUqiCLmjk8TD",
    "82Bk9zzCJrkSoyFdJt6zsRz3MMpSxptmnh5ZGJ5dB1Gz",
    "DyBMZNTCuZRpXDNT5MW6VWngkAoJznhZXPzwQrH8HH8w",
    "JYx3Vh2vHbJxrDdD4bpPYfNscTBKjueHh746j3wJHk3",
    "J2vigdNQQ6Wne7ieVKf4wShteT9zMVN8673zKfKTDop8",
    "dFBU4D6bRLtbH4LbQxtQ8WhxEr3zNC5yQGvHoSvioMs",
    "CFLVfLw5uAawiKU7jtb6MDMysxW8fppYzwmk7dSW8LDc",
    "J1svDLwqEE28CT5JXnB474dGdaTgFBNxrNTaGEenZPV4",
    "CuGZrnYJyjbWShhzViXvhGJgxEwVedp9LzmAse9MCEPh",
    "BySjJVU4gcNS4iYjqBipuNPHrNNWnAz7AxNhnA2ij71U",
    "2kdo5WXw7dNXLiHeb13vtmFczq4xtXWTVy6Smq1EeoZR",
    "AEFJg6aiaaNQEtfRMeacGnuR26kV5LwtBMB2VLnLMGCx",
    "734vkZCfb13bGBFdVjjxL5emCkrPiATfYwgGd5k3Nfrb",
    "3GEzbCkpM9sHRA53bbu9278VEMs8gyp7Cy5sqEbEHqV2",
    "8i6qvxVKCVouEhJxBN35TnereGDm6bQ4ncz6fMLrykQ5",
    "2PmSux5t1jXAMew3o7qbL1s8mXULUUK3PPT7rSCNhSSi",
    "2LCdZGKmYo7A5ntRqhqtugNczvbdaViKrYAXGw7tm31E",
    "6rsmJMWTDWRU53qynT5hDFW1uHZFzoSP35jokZ8os4Rz",
    "HsavXvnc97Zd6mJtxxqnu28sobyfjjksm2hwD1kjDpeh",
    "43i83LSxBmqQqbrDCF8npCerXjFAxMhdYonq7HxgRrVy",
    "DKEurqRXQ1ugJEFtuzv8kbfDe6t3LLCmR7nw2gcqB6jx",
    "F9viHA7wc581h5WNSJhTAAh7Kj7D9w5nLwjYpPkVfVYy",
    "DU9e54N3aRfpiiYFwA2ui98VQ9ou5wiyxqPckNWgwEkE",
    "CqQPiaUXiAvVmWkpM21XbMfGkzpeFETRK5bn4tHfeub6",
    "FATxK4q4LE5xVQoH23zdwPZPdAhu6C2eAxRoMcHr5B8h",
    "Cq65LrwhfHzMcez8zn4wznZ9dnjtJDKDM1gCx99pEYkJ",
    "Fz1DM423jdioW18sRUZuABrsjS7JhsFE9CBvjCDPMev5",
    "GJ2DSJ7uhe77o6dU45QwQP3S12L6axV6ttTCDvTmf4py",
    "BvqW2kJvgbfLA6mQEiy4yJs3mh74ZDp5xCr1SBiZvdcA",
    "9RCwKn1NuLBpn94an7iCiVRLnr8qdNjynd3tCiCByfJd",
    "46ZRReRkyrGcq2WaNxrPPW8as4osT6n8U3Q8KXFFNGqw",
    "7VxBMmbGweNqdetSxb7gkSDD34SaWaT2TVmJ39Jz5775",
    "7kM71BBMp977K1rLBJiAHa1nP65gEJPkQ2UhqaPHLfBB",
    "H5JNTG1KQzfsH2PfjopdkwfxFoTWEcNYxhK6SfVsYy2Y",
    "HrqebbZyXrZSvqaCmTuWvEFhjJerZgKN2T7yGcHaobQv",
    "3o2gKTkemaxxTZuCXYNnK2hXuqhn6vm5B6W66Xwr1L7U",
    "CVEWdb6GhHUHujSeZQvNtgZfoPXQr8QUfiRrVZvmZJPn",
    "8BoaeWVGgBDEbpg5822syUdDU4j7hySK8tDhCj2SzmZ6",
    "HMWDY6i1voJzLjCKeS1sXpCNZwNxLXE3pYtJ9JjstLmN",
    "FoHgJbRATiZ7TczAVPxHuajf4a6qRKrLQuftfDB76EWu",
    "8TZuyp7he1NN3RBWWdcWapLRggwZeSGs8DQ3aUuokqLA",
    "9JXWkioogAJNP4ESV8xUaLYdNtyvyBvDtq7CMA4Cj91v",
    "HziqN1621gpj6VtdvvRJgoD66ccjLoYeMqHodETQqZHB",
    "59vShiKvW8ZLYse8WkV53eBSDBkBozUqehbPeRbXBzWP",
    "9xp8pFNaCowVr7T6Qy5EXLuX3ZS7nF8YoVh7h2sTtUfY",
    "2astmMbUTtArmA7etHVqh9ZE3GhRNCQ7xG5WYQvSBSbu",
    "7p1qpzvQob4KLvQm3K2i36EKmwhcx9QGonvqWiw5Ayvg",
    "GA8F5iSAVGH7FupzeHuZ1xX1L3USQRWKZrt44qsF38ZA",
    "HKZeZzLZk24HyNjMmSfqRwTqgSQ5ptmedGpAxzwvVkg4",
    "GTdg3TSgb9p5mJrbVwU481d4Ai86kadWBpsfPmYAmoeU",
    "6bihDJGPYsnPSDkFq7FKjhWwq6ffDrTXDeWABV4TnzC5",
    "5aLYovFYbfFgsLLZ1FTgv4QXVdkBX989Ym6cMRsPYog",
    "7xxZuaMQRzbC2MEGyTtfNKNusa12DgKYMxBuksrt1CR6",
    "4cz8mDNRuMAEYkXyF4hYzWaidF6v4x8mbqewC1CDqT4z",
    "GMrmvmPP7LGKRb3vxWNLaZM33EnLX1efM9GkKp3gZsN1",
    "9uQNAQpcVokJdS6hGBYTfZ6QUiQvuWGz6eAcAkNPbSp",
    "fPUdFBFkjKYcuSRKKGCE5SzuSXYDQj8XZXmiN8yW7H7",
    "AiboggivixjSVFWFFRMZc5YTAkxpMoVUohKoZALucQ4W",
    "7kT8kDxPyMU1cgAw43eg61bdsLbZPiZSDYkE7s2i9duc",
    "5BW1RL8eznidbXB271wiGkNqkAeJnG689SKrTjdT5yiN",
    "7jJdrPKd6daGzuzWkBDFieuaLdT2zao45udWoogt2Hb4",
    "FAPELahUpRFN5tr8bfNzsPt8RSrxkyXrqW617sev5HD7"
  ];

  const connectedWallet = wallet?.publicKey?.toBase58();

  console.log(connectedWallet)

  return (
    <Container style={{ marginTop: 200 }}>
      <Container maxWidth="xs" style={{ position: "relative" }}>
        <Paper
          style={{
            padding: 24,
            paddingBottom: 10,
            backgroundColor: "#151A1F",
            borderRadius: 6,
          }}
        >
          {!wallet.connected ? (
            <>
              <Typography
                variant="caption"
                align="center"
                display="block"
                style={{ marginTop: 0, color: "grey", fontSize: "1rem" }}
              >
                A rift has opened, through the noise of the rift you can hear
                purring, bongs ripping and the sound of general epicness, will
                you join in and take part?
              </Typography>
              <ConnectButton>Connect Wallet</ConnectButton>
            </>
          ) 
          // :
           : auth.includes(connectedWallet) ? (
            <>
              {candyMachine && (
                <>
                  <Typography
                    variant="caption"
                    align="center"
                    display="block"
                    style={{
                      marginTop: 0,
                      marginBottom: 10,
                      color: "grey",
                      fontSize: "1rem",
                    }}
                  >
                    Creck you say? I hear that those who are baked enjoy it...
                  </Typography>
                  <Grid
                    container
                    direction="row"
                    justifyContent="center"
                    wrap="nowrap"
                  >
                    <Grid item xs={3}>
                      <Typography variant="body2" color="textSecondary">
                        Remaining
                      </Typography>
                      <Typography
                        variant="h6"
                        color="textPrimary"
                        style={{
                          fontWeight: "bold",
                        }}
                      >
                        {`${itemsRemaining}`}
                      </Typography>
                    </Grid>
                    <Grid item xs={4}>
                      <Typography variant="body2" color="textSecondary">
                        {isWhitelistUser && discountPrice
                          ? "Discount Price"
                          : "Price"}
                      </Typography>
                      <Typography
                        variant="h6"
                        color="textPrimary"
                        style={{ fontWeight: "bold" }}
                      >
                        {isWhitelistUser && discountPrice
                          ? `${formatNumber.asNumber(discountPrice)} SOL`
                          : `${formatNumber.asNumber(
                              candyMachine.state.price
                            )} SOL`}
                      </Typography>
                    </Grid>
                    <Grid item xs={5}>
                      {isActive && endDate && Date.now() < endDate.getTime() ? (
                        <>
                          <MintCountdown
                            key="endSettings"
                            date={getCountdownDate(candyMachine)}
                            style={{ justifyContent: "flex-end" }}
                            status="COMPLETED"
                            onComplete={toggleMintButton}
                          />
                          <Typography
                            variant="caption"
                            align="center"
                            display="block"
                            style={{ fontWeight: "bold" }}
                          >
                            TO END OF MINT
                          </Typography>
                        </>
                      ) : (
                        <>
                          <MintCountdown
                            key="goLive"
                            date={getCountdownDate(candyMachine)}
                            style={{ justifyContent: "flex-end" }}
                            status={
                              candyMachine?.state?.isSoldOut ||
                              (endDate && Date.now() > endDate.getTime())
                                ? "COMPLETED"
                                : isPresale
                                ? "PRESALE"
                                : "LIVE"
                            }
                            onComplete={toggleMintButton}
                          />
                          {isPresale &&
                            candyMachine.state.goLiveDate &&
                            candyMachine.state.goLiveDate.toNumber() >
                              new Date().getTime() / 1000 && (
                              <Typography
                                variant="caption"
                                align="center"
                                display="block"
                                style={{ fontWeight: "bold" }}
                              >
                                UNTIL PUBLIC MINT
                              </Typography>
                            )}
                        </>
                      )}
                    </Grid>
                  </Grid>
                </>
              )}
              <MintContainer>
                {candyMachine?.state.isActive &&
                candyMachine?.state.gatekeeper &&
                wallet.publicKey &&
                wallet.signTransaction ? (
                  <GatewayProvider
                    wallet={{
                      publicKey:
                        wallet.publicKey ||
                        new PublicKey(CANDY_MACHINE_PROGRAM),
                      //@ts-ignore
                      signTransaction: wallet.signTransaction,
                    }}
                    gatekeeperNetwork={
                      candyMachine?.state?.gatekeeper?.gatekeeperNetwork
                    }
                    clusterUrl={rpcUrl}
                    cluster={cluster}
                    handleTransaction={async (transaction: Transaction) => {
                      setIsUserMinting(true);
                      const userMustSign = transaction.signatures.find((sig) =>
                        sig.publicKey.equals(wallet.publicKey!)
                      );
                      if (userMustSign) {
                        setAlertState({
                          open: true,
                          message: "Please sign one-time Civic Pass issuance",
                          severity: "info",
                        });
                        try {
                          transaction = await wallet.signTransaction!(
                            transaction
                          );
                        } catch (e) {
                          setAlertState({
                            open: true,
                            message: "User cancelled signing",
                            severity: "error",
                          });
                          // setTimeout(() => window.location.reload(), 2000);
                          setIsUserMinting(false);
                          throw e;
                        }
                      } else {
                        setAlertState({
                          open: true,
                          message: "Refreshing Civic Pass",
                          severity: "info",
                        });
                      }
                      try {
                        await sendTransaction(
                          props.connection,
                          wallet,
                          transaction,
                          [],
                          true,
                          "confirmed"
                        );
                        setAlertState({
                          open: true,
                          message: "Please sign minting",
                          severity: "info",
                        });
                      } catch (e) {
                        setAlertState({
                          open: true,
                          message:
                            "Solana dropped the transaction, please try again",
                          severity: "warning",
                        });
                        console.error(e);
                        // setTimeout(() => window.location.reload(), 2000);
                        setIsUserMinting(false);
                        throw e;
                      }
                      await onMint();
                    }}
                    broadcastTransaction={false}
                    options={{ autoShowModal: false }}
                  >
                    <MintButton
                      candyMachine={candyMachine}
                      isMinting={isUserMinting}
                      setIsMinting={(val) => setIsUserMinting(val)}
                      onMint={onMint}
                      isActive={
                        isActive ||
                        (isPresale && isWhitelistUser && isValidBalance)
                      }
                    />
                  </GatewayProvider>
                ) : (
                  <MintButton
                    candyMachine={candyMachine}
                    isMinting={isUserMinting}
                    setIsMinting={(val) => setIsUserMinting(val)}
                    onMint={onMint}
                    isActive={
                      isActive ||
                      (isPresale && isWhitelistUser && isValidBalance)
                    }
                  />
                )}
              </MintContainer>
            </>
          ) : (
            <h2 className="notWhitelist">Your wallet is not whitelisted.</h2>
          )
        }
          <Typography
            variant="caption"
            align="center"
            display="block"
            style={{ marginTop: 7, color: "grey" }}
          >
            Brought to you by Syndic Industries
          </Typography>
        </Paper>
      </Container>

      <Snackbar
        open={alertState.open}
        autoHideDuration={
          alertState.hideDuration === undefined ? 6000 : alertState.hideDuration
        }
        onClose={() => setAlertState({ ...alertState, open: false })}
      >
        <Alert
          onClose={() => setAlertState({ ...alertState, open: false })}
          severity={alertState.severity}
        >
          {alertState.message}
        </Alert>
      </Snackbar>
    </Container>
  );
};

const getCountdownDate = (
  candyMachine: CandyMachineAccount
): Date | undefined => {
  if (
    candyMachine.state.isActive &&
    candyMachine.state.endSettings?.endSettingType.date
  ) {
    return toDate(candyMachine.state.endSettings.number);
  }

  return toDate(
    candyMachine.state.goLiveDate
      ? candyMachine.state.goLiveDate
      : candyMachine.state.isPresale
      ? new anchor.BN(new Date().getTime() / 1000)
      : undefined
  );
};

export default Home;
