/**
 * BellaHealthWidgetBridge.m
 *
 * Obj-C bridge declaration for BellaHealthWidgetBridge.
 * The Swift implementation lives in BellaHealthWidgetBridge.swift.
 * This file registers the module with the React Native bridge (old architecture).
 */

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(BellaHealthWidgetBridge, NSObject)

RCT_EXTERN_METHOD(writeSnapshot:(NSDictionary *)data
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
